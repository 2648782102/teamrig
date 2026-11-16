import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { isAllowedGh, pullFilesArgs, pullReadArgs, pullReviewArgs, viewerReadArgs } from '../github/gh.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM, type CliResult } from '../testing/cli-harness.ts';
import { ghJson, ScriptedGh } from '../testing/scripted-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, roles: { lead: 'lead', securityReviewer: 'bravo' }, github: { repos: ['acme/web'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const ACCESS = 'ACCESS acme: writes with the token saved as teamrig-gh-acme';
const TARGET = { repo: 'acme/web', number: 7 };
const HEAD = 'a'.repeat(40);
const NOTES = join(APP, 'review.md');

function printed(result: CliResult): string {
  return [...result.stdout, ...result.stderr].join('\n');
}

/** GitHub holding acme/web#7, open at HEAD by `outsider` and changing `paths`, read by the token's account `teamrig-bot`. */
function github(paths: readonly string[] = ['docs/a.md'], pull: JsonRecord = {}): ScriptedGh {
  return new ScriptedGh()
    .answers(pullReadArgs(TARGET), ghJson({ state: 'open', merged_at: null, user: { login: 'outsider' }, head: { sha: HEAD }, ...pull }))
    .answers(viewerReadArgs(), ghJson({ login: 'teamrig-bot' }))
    .answers(pullFilesArgs(TARGET, 1), ghJson(paths.map((filename) => ({ filename, status: 'modified' }))))
    .answers(pullReviewArgs(TARGET, { event: 'APPROVE', commit: HEAD }), ghJson({ id: 1 }))
    .answers(pullReviewArgs(TARGET, { event: 'REQUEST_CHANGES', commit: HEAD, body: 'Add a test.' }), ghJson({ id: 2 }));
}

function posted(gh: ScriptedGh): number {
  return gh.ran.filter((request) => request.args.includes('POST')).length;
}

/** A team whose T1, owned by `owner`, is set to `status` by that owner. */
async function teamWithTask(owner: string, status: 'done' | 'in-progress', config: JsonRecord = GITHUB_TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  const steps = [['add', '--owner', owner, '--title', 'Security pass of the change', '--description', 'what and why', '--priority', 'p1']];
  steps.push(
    status === 'done'
      ? ['set', 'T1', '--status', 'done', '--note', 'passed', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', owner]
      : ['set', 'T1', '--status', 'in-progress', '--session', owner],
  );
  for (const argv of steps) {
    const result = await kit.run(argv, AS_LEAD);
    assert.equal(result.code, EXIT.ok, printed(result));
  }
  return kit;
}

describe('teamrig pr review', () => {
  it('approves at the head read, by allowed calls only, and writes nothing to the task list', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const log = kit.files.get(EVENTS_PATH);
    const gh = github();
    const result = await kit.run(['pr', 'review', 'Acme/Web#7', '--approve', '--head', HEAD.toUpperCase()], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.deepEqual(result.stdout, [ACCESS, 'REVIEWED acme/web#7: approved at aaaaaaaaa']);
    assert.ok(gh.ran.every((request) => isAllowedGh(request.args)));
    assert.deepEqual(gh.ran.at(-1)?.args, pullReviewArgs(TARGET, { event: 'APPROVE', commit: HEAD }));
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('requests changes with the body file, and refuses a change request with none', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await kit.files.write(NOTES, '﻿Add a test.');
    const gh = github();
    const result = await kit.run(['pr', 'review', 'acme/web#7', '--request-changes', '--head', HEAD, '--body-file', 'review.md'], { ...AS_LEAD, gh });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.deepEqual(result.stdout, [ACCESS, 'REVIEWED acme/web#7: changes requested at aaaaaaaaa']);
    assert.deepEqual(gh.ran.at(-1)?.args, pullReviewArgs(TARGET, { event: 'REQUEST_CHANGES', commit: HEAD, body: 'Add a test.' }));
    const bare = await kit.run(['pr', 'review', 'acme/web#7', '--request-changes', '--head', HEAD], { ...AS_LEAD, gh: new ScriptedGh() });
    assert.equal(bare.code, EXIT.refused);
    assert.match(printed(bare), /^REFUSED --request-changes needs --body-file: a change request says what to change/u);
  });

  it('refuses, running no gh, a missing or double verdict, a short head, a pass on a change request, a stranger, an unlisted repository and a body naming a task id', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await kit.files.write(NOTES, 'Fixed in T12');
    const gh = new ScriptedGh();
    const cases: Array<[readonly string[], Readonly<Record<string, string>>, RegExp]> = [
      [['pr', 'review', 'acme/web#7', '--head', HEAD], AS_LEAD.env, /^REFUSED pr review takes one of --approve and --request-changes/u],
      [['pr', 'review', 'acme/web#7', '--approve', '--request-changes', '--head', HEAD], AS_LEAD.env, /^REFUSED pr review takes one of --approve and --request-changes/u],
      [['pr', 'review', 'acme/web#7', '--approve', '--head', 'abc1234'], AS_LEAD.env, /^REFUSED --head takes the full 40-character id of the head commit you read/u],
      [['pr', 'review', 'acme/web#7', '--request-changes', '--head', HEAD, '--body-file', NOTES, '--verdict', 'T1'], AS_LEAD.env, /^REFUSED --verdict names the security pass an approval needs/u],
      [['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD], { TEAMRIG_SESSION: 'stranger' }, /^REFUSED stranger is not a session on this team/u],
      [['pr', 'review', 'acme/api#7', '--approve', '--head', HEAD], AS_LEAD.env, /^REFUSED acme\/api is not one of the team's repositories/u],
      [['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD, '--body-file', NOTES], AS_LEAD.env, /^REFUSED --body-file names the task id T12/u],
    ];
    for (const [argv, env, error] of cases) {
      const result = await kit.run(argv, { env, gh });
      assert.equal(result.code, EXIT.refused, `${argv.join(' ')}\n${printed(result)}`);
      assert.match(printed(result), error, argv.join(' '));
    }
    const headless = await kit.run(['pr', 'review', 'acme/web#7', '--approve'], { ...AS_LEAD, gh });
    assert.match(printed(headless), /--head is required/u);
    assert.deepEqual(gh.ran, []);
  });

  it('posts nothing, and fails, when the head moved since the read or the pull request is closed', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const moved = github(undefined, { head: { sha: 'b'.repeat(40) } });
    const late = await kit.run(['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD], { ...AS_LEAD, gh: moved });
    assert.equal(late.code, EXIT.failed);
    assert.match(printed(late), /FAILED acme\/web#7: its head is now bbbbbbbbb, not the aaaaaaaaa you read/u);
    assert.equal(posted(moved), 0);
    const closed = github(undefined, { state: 'closed' });
    const shut = await kit.run(['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD], { ...AS_LEAD, gh: closed });
    assert.match(printed(shut), /FAILED acme\/web#7: it is closed: a review goes only on an open pull request; no review was posted/u);
    assert.equal(posted(closed), 0);
  });

  it("holds an approval of a change to a generic security path, or to one of pushGuard.reviewPaths, until the security reviewer's done task is named", async () => {
    const config: JsonRecord = { ...GITHUB_TEAM, pushGuard: { reviewPaths: [{ glob: 'src/guard/**', mode: 'check', class: 'security' }] } };
    const kit = await teamWithTask('bravo', 'done', config);
    for (const path of ['.github/workflows/ci.yml', 'src/guard/exec.ts']) {
      const held = github(['docs/a.md', path]);
      const refused = await kit.run(['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD], { ...AS_LEAD, gh: held });
      assert.equal(refused.code, EXIT.failed, path);
      assert.match(printed(refused), new RegExp(`it changes ${path.replaceAll('.', '\\.')}, under the review gate's security paths: approve it only with --verdict`, 'u'));
      assert.equal(posted(held), 0);
    }
    const passed = github(['src/guard/exec.ts']);
    const result = await kit.run(['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD, '--verdict', 'T1'], { ...AS_LEAD, gh: passed });
    assert.equal(result.code, EXIT.ok, printed(result));
    assert.deepEqual(result.stdout, [ACCESS, 'REVIEWED acme/web#7: approved at aaaaaaaaa, its gated paths passed by T1 (done by bravo)']);
    assert.equal(posted(passed), 1);
  });

  it("refuses, running no gh, a pass that is no task, not the security reviewer's, or not done, and one on a team with no reviewer", async () => {
    const cases: Array<[CliHarness, string, RegExp]> = [
      [await teamWithTask('bravo', 'done'), 'T9', /^REFUSED --verdict T9 is no task of the team tree/u],
      [await teamWithTask('bravo', 'done'), 'pass', /^REFUSED --verdict takes the security reviewer's done task, such as T12, not "pass"/u],
      [await teamWithTask('alpha', 'done'), 'T1', /^REFUSED --verdict T1 is not a task of bravo, the security reviewer/u],
      [await teamWithTask('bravo', 'in-progress'), 'T1', /^REFUSED --verdict T1 is in-progress, not done: approve once bravo has passed the change/u],
      [await teamWithTask('bravo', 'done', { ...GITHUB_TEAM, roles: { lead: 'lead' } }), 'T1', /^REFUSED the team names no security reviewer \(roles\.securityReviewer\)/u],
    ];
    for (const [kit, verdict, error] of cases) {
      const gh = new ScriptedGh();
      const result = await kit.run(['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD, '--verdict', verdict], { ...AS_LEAD, gh });
      assert.equal(result.code, EXIT.refused, printed(result));
      assert.match(printed(result), error);
      assert.deepEqual(gh.ran, []);
    }
  });

  it('writes nothing while GitHub is off on the machine', async () => {
    const gh = new ScriptedGh();
    const result = await new CliHarness(GITHUB_TEAM).run(['pr', 'review', 'acme/web#7', '--approve', '--head', HEAD], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });
});
