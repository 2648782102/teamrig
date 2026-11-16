import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPull } from '../issues/pull.ts';
import { ghPull, type PullSpec } from '../testing/fake-gh.ts';
import { testHostIssue } from '../testing/host-issue.ts';
import { driftKey, driftText, formatDrift, issueDrift, parseDrift, pullDrift, stepDrift, type DriftRead, type IssueDrift, type PullDrift } from './drift.ts';
import { pullOf } from './pulls.ts';

const row = (overrides: Partial<IssueDrift> = {}): IssueDrift => ({ repo: 'acme/web', ref: 'gh:acme/web#9', kind: 'linked-pull', shown: ['status:open'], assigned: false, ...overrides });
const pullRow = (overrides: Partial<PullDrift> = {}): PullDrift => ({ repo: 'acme/web', ref: 'gh:acme/web#12', kind: 'pull-unlabelled', ...overrides });

/** An open pull request by a person outside the repository, read through the shipped parser. */
function outsidePull(spec: PullSpec = {}): HostPull {
  const read = pullOf(ghPull('acme/web', 12, { authorAssociation: 'CONTRIBUTOR', author: 'stranger', ...spec }), 'acme/web');
  assert.ok(read !== null);
  return read;
}

const OURS: ReadonlySet<string> = new Set(['teammate']);

const both = (repos: readonly string[]): DriftRead => ({ issues: new Set(repos), pulls: new Set(repos) });

describe('issueDrift (T3205)', () => {
  it('flags the #922 case: an open pull request closes it while it shows status:open and no one is assigned', () => {
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 1, labels: ['bug', 'status:open'] })), [row()]);
  });

  it('flags one with no status label, and keeps whether it is assigned', () => {
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 2, assignees: ['octocat'] })), [row({ shown: [], assigned: true })]);
  });

  it('leaves out one showing status:in review in any case, one no pull request closes, and a closed one', () => {
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 1, labels: ['Status:In Review'] })), []);
    assert.deepEqual(issueDrift(testHostIssue(9, { labels: ['status:open'] })), []);
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 1, state: 'closed' })), []);
  });
});

describe('pullDrift', () => {
  it('flags an open outside pull request no one labelled, a draft too', () => {
    assert.deepEqual(pullDrift(outsidePull(), OURS), [pullRow()]);
    assert.deepEqual(pullDrift(outsidePull({ authorAssociation: 'NONE', isDraft: true }), OURS), [pullRow()]);
  });

  it('leaves out a labelled one, a closed or merged one, and one an app opened', () => {
    assert.deepEqual(pullDrift(outsidePull({ labels: 1 }), OURS), []);
    assert.deepEqual(pullDrift(outsidePull({ state: 'CLOSED' }), OURS), []);
    assert.deepEqual(pullDrift(outsidePull({ state: 'MERGED' }), OURS), []);
    assert.deepEqual(pullDrift(outsidePull({ authorKind: 'Bot', author: 'dependabot' }), OURS), []);
  });

  it("leaves out the repository's own people and the team's named logins in any case", () => {
    for (const association of ['OWNER', 'MEMBER', 'collaborator']) {
      assert.deepEqual(pullDrift(outsidePull({ authorAssociation: association }), OURS), [], association);
    }
    assert.deepEqual(pullDrift(outsidePull({ author: 'Teammate' }), OURS), []);
  });
});

describe('stepDrift', () => {
  it('replaces the rows of each repository read and keeps those of one not read', () => {
    const other = row({ repo: 'acme/api', ref: 'gh:acme/api#3' });
    const fixed = row();
    const fresh = row({ ref: 'gh:acme/web#4' });
    assert.deepEqual(stepDrift([other, fixed], both(['acme/web']), [fresh, row({ repo: 'acme/api', ref: 'gh:acme/api#8' })]), [other, fresh]);
  });

  it('keeps the pull request rows of a repository whose pull requests were not read, while its issues were', () => {
    const issueRead: DriftRead = { issues: new Set(['acme/web']), pulls: new Set() };
    assert.deepEqual(stepDrift([row(), pullRow()], issueRead, [row({ ref: 'gh:acme/web#4' }), pullRow({ ref: 'gh:acme/web#20' })]), [pullRow(), row({ ref: 'gh:acme/web#4' })]);
  });
});

describe('the drift file', () => {
  it('reads back what it writes, and reads a damaged row, file or another format as none', () => {
    const rows = [row(), row({ ref: 'gh:acme/web#4', shown: [], assigned: true }), pullRow()];
    assert.deepEqual(parseDrift(formatDrift(rows)), rows);
    assert.deepEqual(parseDrift('{"v":1,"drift":[{"repo":"acme/web","ref":"gh:acme/web#9","kind":"other","shown":[],"assigned":false}]}'), []);
    assert.deepEqual(parseDrift('{"v":1,"drift":[{"repo":"acme/web","ref":"gh:acme/web#9","kind":"linked-pull"}]}'), [], 'an issue row needs what it showed');
    assert.deepEqual(parseDrift('{"v":2,"drift":[]}'), []);
    assert.deepEqual(parseDrift('not json'), []);
  });

  it('writes only the fields of its kind', () => {
    const extra: PullDrift & { readonly shown: readonly string[] } = { ...pullRow(), shown: ['status:open'] };
    assert.equal(formatDrift([extra]).trim(), '{"v":1,"drift":[{"repo":"acme/web","ref":"gh:acme/web#12","kind":"pull-unlabelled"}]}');
  });
});

describe('the GH-DRIFT line', () => {
  it('names the thread, what it shows and the fix, keyed by thread and kind', () => {
    assert.equal(driftKey(row()), 'gh-drift gh:acme/web#9 linked-pull');
    assert.equal(
      driftText(row()),
      "GH-DRIFT gh:acme/web#9: an open pull request closes it, yet it shows status:open and no assignee, not status:in review: have its task's owner set it verifying, or the pull request's author unlink it",
    );
    assert.match(driftText(row({ shown: [], assigned: true })), /yet it shows no status label, not status:in review/);
  });

  it('names an outside pull request no one labelled and the fix', () => {
    assert.equal(driftKey(pullRow()), 'gh-drift gh:acme/web#12 pull-unlabelled');
    assert.equal(driftText(pullRow()), 'GH-DRIFT gh:acme/web#12: an outside pull request no one labelled, so no maintainer took it in: label it as you take it in, or close it saying why');
  });
});
