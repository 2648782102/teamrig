import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXIT, RefusedError } from '../../src/cli/runtime.ts';
import { CliHarness } from '../../src/testing/cli-harness.ts';
import { closingIssue, closingIssueFrom, closingIssueOn, type TaskOf } from './closes.ts';

const ENV = { TEAMRIG_SESSION: 'alpha', TEAMRIG_TEAM: 'app' };

/** A team whose T1 is alpha's; with `ref`, the lead links it to that issue as an import would. */
async function teamWithTask(ref?: string): Promise<CliHarness> {
  const kit = new CliHarness();
  assert.equal((await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha'])).code, EXIT.ok);
  if (ref !== undefined) {
    const run = await kit.run(['update', 'T1', '--ref', ref, '--session', 'lead']);
    assert.equal(run.code, EXIT.ok, run.stderr.join('\n'));
  }
  return kit;
}

describe('closingIssue', () => {
  it("closes the issue the task's gh: ref names, in the full owner/name#n form", () => {
    assert.deepEqual(closingIssue('t1-cli', 'T1', { ref: 'gh:Owner/repo#12' }), { kind: 'closes', line: 'Closes owner/repo#12' });
  });

  it('closes nothing, saying why, for a branch with no task, a task the register lacks, and a ref that is no issue', () => {
    assert.deepEqual(closingIssue('cli-fix', null, undefined), { kind: 'none', why: 'branch cli-fix names no task' });
    assert.deepEqual(closingIssue('t1-cli', 'T1', undefined), { kind: 'none', why: 'the register holds no task T1' });
    const none = { kind: 'none', why: 'T1 has no issue ref (gh:owner/name#n)' };
    assert.deepEqual(closingIssue('t1-cli', 'T1', { ref: null }), none);
    assert.deepEqual(closingIssue('t1-cli', 'T1', { ref: 'chat 11-15' }), none);
    assert.deepEqual(closingIssue('t1-cli', 'T1', { ref: 'gh:not an issue' }), none);
  });
});

describe('closingIssueFrom', () => {
  it("reads the branch's task from the register of the team the env names", async () => {
    const linked = await teamWithTask('gh:owner/repo#7');
    assert.deepEqual(await closingIssueFrom(ENV, linked.runtime())('t1-cli'), { kind: 'closes', line: 'Closes owner/repo#7' });
    const unlinked = await teamWithTask();
    assert.deepEqual(await closingIssueFrom(ENV, unlinked.runtime())('t1-cli'), { kind: 'none', why: 'T1 has no issue ref (gh:owner/name#n)' });
    assert.deepEqual(await closingIssueFrom(ENV, unlinked.runtime())('t2-cli'), { kind: 'none', why: 'the register holds no task T2' });
  });

  it('closes nothing for a branch with no task or an env with no team, reading no register', async () => {
    const kit = await teamWithTask('gh:owner/repo#7');
    assert.deepEqual(await closingIssueFrom(ENV, kit.runtime())('cli-fix'), { kind: 'none', why: 'branch cli-fix names no task' });
    assert.deepEqual(await closingIssueFrom({ TEAMRIG_TEAM: ' ' }, kit.runtime())('t1-cli'), { kind: 'none', why: 'TEAMRIG_TEAM names no team to read the register of' });
  });

  it("gives none with the kit's refusal, and lets any other failure through", async () => {
    const refusing: TaskOf = async () => {
      throw new RefusedError("team app's config is missing");
    };
    assert.deepEqual(await closingIssueOn('app', refusing, 't1-cli'), { kind: 'none', why: "team app's config is missing" });
    const broken: TaskOf = async () => {
      throw new Error('disk gone');
    };
    await assert.rejects(closingIssueOn('app', broken, 't1-cli'), /disk gone/);
  });
});
