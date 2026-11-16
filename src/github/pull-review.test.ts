import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeCredentials, ownerToken, TEST_OWNERS } from '../testing/fake-credentials.ts';
import { ghJson, ScriptedGh } from '../testing/scripted-gh.ts';
import { isAllowedGh, PULL_FILES_PAGE, PULL_FILES_PAGES, pullFilesArgs, pullReadArgs, pullReviewArgs, viewerReadArgs, type GhResult } from './gh.ts';
import { filesIn, GitHubPullReviewHost, pullFactsIn } from './pull-review.ts';
import { RepoTokens } from './tokens.ts';

const TARGET = { repo: 'acme/web', number: 7 };
const HEAD = 'a'.repeat(40);
const OPEN_PULL = { state: 'open', merged_at: null, user: { login: 'outsider' }, head: { sha: HEAD } };

function failed(code: number, stderr: string): GhResult {
  return { end: { kind: 'exited', code }, stdout: '', stderr };
}

function hostWith(gh: ScriptedGh, credentials: FakeCredentials = new FakeCredentials().savesTokensFor(TEST_OWNERS)): GitHubPullReviewHost {
  return new GitHubPullReviewHost(gh, new RepoTokens(credentials, { HOME: '/u' }), new SecretScanner(['tok_[a-z0-9]{8}']));
}

/** `count` changed files named `<prefix><k>`, as one page of the REST files list prints them. */
function filesPage(prefix: string, count: number): unknown[] {
  return Array.from({ length: count }, (_, k) => ({ filename: `${prefix}${k}`, status: 'modified' }));
}

describe('a pull request read on GitHub', () => {
  it('gives its state, author and head, with the owner token, by one allowed read', async () => {
    const gh = new ScriptedGh().answers(pullReadArgs(TARGET), ghJson(OPEN_PULL));
    assert.deepEqual(await hostWith(gh).pull(TARGET), { kind: 'found', pull: { state: 'open', author: 'outsider', head: HEAD } });
    assert.deepEqual(gh.ran.map((request) => [isAllowedGh(request.args), request.env['GH_TOKEN']]), [[true, ownerToken('acme')]]);
  });

  it('tells a merged pull request from a closed one, as both say closed', () => {
    assert.equal(pullFactsIn(JSON.stringify({ ...OPEN_PULL, state: 'closed', merged_at: '2026-11-16T09:00:00Z' }))?.state, 'merged');
    assert.equal(pullFactsIn(JSON.stringify({ ...OPEN_PULL, state: 'closed', merged: true }))?.state, 'merged');
    assert.equal(pullFactsIn(JSON.stringify({ ...OPEN_PULL, state: 'closed' }))?.state, 'closed');
    assert.equal(pullFactsIn(JSON.stringify({ ...OPEN_PULL, user: { login: 'dependabot[bot]' } }))?.author, 'dependabot[bot]');
  });

  it('takes nothing from a read missing a field or holding a malformed one', () => {
    for (const pull of [
      { ...OPEN_PULL, state: 'draft' },
      { ...OPEN_PULL, user: null },
      { ...OPEN_PULL, user: { login: 'bad login' } },
      { ...OPEN_PULL, head: { sha: 'abc123' } },
      { ...OPEN_PULL, head: { sha: 'A'.repeat(40) } },
      [],
    ]) {
      assert.equal(pullFactsIn(JSON.stringify(pull)), undefined, JSON.stringify(pull));
    }
    assert.equal(pullFactsIn('not json'), undefined);
  });

  it('is missing when GitHub has no such pull request, and fails on output it cannot read', async () => {
    assert.deepEqual(await hostWith(new ScriptedGh()).pull(TARGET), { kind: 'missing' });
    const garbled = new ScriptedGh().answers(pullReadArgs(TARGET), { end: { kind: 'exited', code: 0 }, stdout: '<html>', stderr: '' });
    assert.deepEqual(await hostWith(garbled).pull(TARGET), { kind: 'failed', reason: 'gh printed no pull request for acme/web#7' });
  });

  it('says a refused token is to be saved again, and redacts a secret gh printed', async () => {
    const refused = new ScriptedGh().answers(pullReadArgs(TARGET), failed(1, 'gh: Bad credentials (HTTP 401)\n'));
    const read = await hostWith(refused).pull(TARGET);
    assert.ok(read.kind === 'failed' && /^GitHub refused the token saved as .+ \(expired or revoked\?\)/u.test(read.reason), JSON.stringify(read));
    const leaky = new ScriptedGh().answers(pullReadArgs(TARGET), failed(1, 'gh: server error tok_abcdefgh\n'));
    const leaked = await hostWith(leaky).pull(TARGET);
    assert.ok(leaked.kind === 'failed' && !leaked.reason.includes('tok_abcdefgh') && leaked.reason.includes('[redacted'), JSON.stringify(leaked));
  });

  it('fails with the store reason, and runs no gh, when the owner has no saved token', async () => {
    const gh = new ScriptedGh();
    const read = await hostWith(gh, new FakeCredentials()).pull(TARGET);
    assert.equal(read.kind, 'failed');
    assert.deepEqual(gh.ran, []);
  });
});

describe('the paths a pull request changes', () => {
  it('reads every page until a short one, a renamed file by both its paths', async () => {
    const gh = new ScriptedGh()
      .answers(pullFilesArgs(TARGET, 1), ghJson(filesPage('docs/a', PULL_FILES_PAGE)))
      .answers(pullFilesArgs(TARGET, 2), ghJson([{ filename: 'docs/moved.ts', previous_filename: 'src/github/old.ts', status: 'renamed' }]));
    const read = await hostWith(gh).changedPaths(TARGET);
    assert.ok(read.kind === 'read');
    assert.equal(read.paths.length, PULL_FILES_PAGE + 2);
    assert.deepEqual(read.paths.slice(-2), ['docs/moved.ts', 'src/github/old.ts']);
    assert.ok(gh.ran.every((request) => isAllowedGh(request.args)));
    assert.equal(gh.ran.length, 2);
  });

  it('stops at an empty page when the last full one ended the list', async () => {
    const gh = new ScriptedGh().answers(pullFilesArgs(TARGET, 1), ghJson(filesPage('a', PULL_FILES_PAGE))).answers(pullFilesArgs(TARGET, 2), ghJson([]));
    const read = await hostWith(gh).changedPaths(TARGET);
    assert.ok(read.kind === 'read' && read.paths.length === PULL_FILES_PAGE);
  });

  it('fails rather than judge on part of a change longer than GitHub lists', async () => {
    const gh = new ScriptedGh();
    for (let page = 1; page <= PULL_FILES_PAGES; page += 1) {
      gh.answers(pullFilesArgs(TARGET, page), ghJson(filesPage(`p${page}/f`, PULL_FILES_PAGE)));
    }
    const read = await hostWith(gh).changedPaths(TARGET);
    assert.deepEqual(read, { kind: 'failed', reason: 'acme/web#7 changes more files than GitHub lists (3000): its paths cannot all be checked' });
    assert.equal(gh.ran.length, PULL_FILES_PAGES);
  });

  it('fails on a missing pull request, a failed page or a page it cannot read', async () => {
    assert.deepEqual(await hostWith(new ScriptedGh()).changedPaths(TARGET), { kind: 'failed', reason: 'acme/web#7 is no pull request the access can see' });
    const second = new ScriptedGh().answers(pullFilesArgs(TARGET, 1), ghJson(filesPage('a', PULL_FILES_PAGE))).answers(pullFilesArgs(TARGET, 2), failed(1, 'gh: HTTP 502\n'));
    assert.equal((await hostWith(second).changedPaths(TARGET)).kind, 'failed');
    const nameless = new ScriptedGh().answers(pullFilesArgs(TARGET, 1), ghJson([{ status: 'added' }]));
    assert.deepEqual(await hostWith(nameless).changedPaths(TARGET), { kind: 'failed', reason: 'gh printed no page of the files of acme/web#7' });
  });

  it('lists a renamed file once when GitHub gives the same old path', () => {
    assert.deepEqual(filesIn(JSON.stringify([{ filename: 'a.ts', previous_filename: 'a.ts' }])), { paths: ['a.ts'], count: 1 });
    assert.equal(filesIn('{}'), undefined);
  });
});

describe('the account a review is posted as', () => {
  it('is the login GitHub gives for the owner token', async () => {
    const gh = new ScriptedGh().answers(viewerReadArgs(), ghJson({ login: 'teamrig-bot', id: 1 }));
    assert.deepEqual(await hostWith(gh).viewer('acme/web'), { kind: 'read', login: 'teamrig-bot' });
    assert.equal(gh.ran[0]?.env['GH_TOKEN'], ownerToken('acme'));
  });

  it('fails when GitHub gives no account or no login of a login shape', async () => {
    assert.deepEqual(await hostWith(new ScriptedGh()).viewer('acme/web'), { kind: 'failed', reason: 'GitHub gave no account for the token' });
    const odd = new ScriptedGh().answers(viewerReadArgs(), ghJson({ login: 'not a login' }));
    assert.deepEqual(await hostWith(odd).viewer('acme/web'), { kind: 'failed', reason: 'gh printed no login for the account the token acts as' });
  });
});

describe('a review posted on GitHub', () => {
  const approve = { target: TARGET, verdict: 'approve' as const, head: HEAD };

  it('posts the verdict bound to the head read, by one allowed call', async () => {
    const gh = new ScriptedGh()
      .answers(pullReviewArgs(TARGET, { event: 'APPROVE', commit: HEAD }), ghJson({ id: 1 }))
      .answers(pullReviewArgs(TARGET, { event: 'REQUEST_CHANGES', commit: HEAD, body: 'Fix the test.' }), ghJson({ id: 2 }));
    const host = hostWith(gh);
    assert.deepEqual(await host.review(approve), { kind: 'done' });
    assert.deepEqual(await host.review({ target: TARGET, verdict: 'request-changes', head: HEAD, body: 'Fix the test.' }), { kind: 'done' });
    assert.ok(gh.ran.every((request) => isAllowedGh(request.args) && request.env['GH_TOKEN'] === ownerToken('acme')));
  });

  it('says what the token lacks when GitHub refuses the review', async () => {
    const gh = new ScriptedGh().answers(pullReviewArgs(TARGET, { event: 'APPROVE', commit: HEAD }), failed(1, 'gh: Resource not accessible by personal access token (HTTP 403)\n'));
    const end = await hostWith(gh).review(approve);
    assert.ok(end.kind === 'failed' && /may not review acme\/web#7: on GitHub, edit that token/u.test(end.reason), JSON.stringify(end));
  });

  it('says to look on GitHub before a rerun when gh was stopped on its way', async () => {
    const gh = new ScriptedGh().answers(pullReviewArgs(TARGET, { event: 'APPROVE', commit: HEAD }), { end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' });
    assert.deepEqual(await hostWith(gh).review(approve), { kind: 'failed', reason: 'gh was stopped (SIGTERM) on its way to review acme/web#7: look on GitHub before a rerun' });
  });
});
