import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ISSUE_FIELDS } from '../../config/defaults.ts';
import type { IssueDraft } from '../../issues/host.ts';
import { issueRulesOf, type IssueRules } from '../../issues/issue-fields.ts';
import type { TaskFields } from '../../register/events.ts';
import type { AddInput, Verdict } from '../../register/policy.ts';
import type { WriteResult } from '../../register/register.ts';
import { FakeIssueHost } from '../../testing/fake-issue-host.ts';
import { testTask } from '../../testing/task.ts';
import { EXIT, RefusedError } from '../runtime.ts';
import { addWithIssue, type IssueAddRegister } from './add-issue.ts';

const INPUT: AddInput = { title: 'Private health check', description: 'private what and why', owner: 'alpha', source: 'lead', priority: 2 };
const DRAFT: IssueDraft = { repo: 'acme/web', title: 'Add a health check', body: 'A probe the load balancer reads.', labels: [], type: null, assignees: [] };
const RULES: IssueRules = issueRulesOf({ owners: { octocat: 'alpha' }, areaOwners: { 'area:sync': 'alpha' }, fields: DEFAULT_ISSUE_FIELDS });

/** A host whose repository has every type and label RULES asks of an open task owned by alpha, so an open says no SKIPPED line. */
function fittingHost(): FakeIssueHost {
  return new FakeIssueHost().hasIssueTypes('Task', 'Bug').hasLabels('status:open', 'area:sync');
}

/** A register that judges and writes as a test sets, and keeps each add it was asked for. */
class FakeAddRegister implements IssueAddRegister {
  readonly adds: AddInput[] = [];
  private readonly judged: Verdict<TaskFields>;
  private readonly written: Verdict<WriteResult>;

  constructor(judged: Verdict<TaskFields> = { ok: true, value: testTask() }, written: Verdict<WriteResult> = { ok: false, error: 'T1 already tracks this (open, owner alpha)' }) {
    this.judged = judged;
    this.written = written;
  }

  judgeAdd(): Promise<Verdict<TaskFields>> {
    return Promise.resolve(this.judged);
  }

  add(_caller: string, input: AddInput): Promise<Verdict<WriteResult>> {
    this.adds.push(input);
    return Promise.resolve(this.written);
  }
}

async function run(register: FakeAddRegister, host: FakeIssueHost | undefined): Promise<{ end: Awaited<ReturnType<typeof addWithIssue>>; said: string[] }> {
  const said: string[] = [];
  const end = await addWithIssue((line) => said.push(line), register, host, 'lead', INPUT, DRAFT, RULES);
  return { end, said };
}

describe('addWithIssue', () => {
  it('refuses an add the register would refuse, opening nothing', async () => {
    const register = new FakeAddRegister({ ok: false, error: 'priority p9 is out of range' });
    const host = new FakeIssueHost();
    await assert.rejects(run(register, host), (error: unknown) => error instanceof RefusedError && /priority p9/u.test(error.message));
    assert.deepEqual([host.calls, register.adds], [[], []]);
  });

  it('refuses with GitHub off on the machine, writing nothing and saying how to go on', async () => {
    const register = new FakeAddRegister();
    await assert.rejects(run(register, undefined), (error: unknown) => error instanceof RefusedError && /TEAMRIG_GITHUB=off .*nothing is written: turn GitHub on, or add the task with --local <reason>$/u.test(error.message));
    assert.deepEqual(register.adds, []);
  });

  it('writes nothing when GitHub cannot be reached', async () => {
    const register = new FakeAddRegister();
    const host = new FakeIssueHost().unreachable('no token saved for acme');
    const { end, said } = await run(register, host);
    assert.deepEqual(end, { kind: 'stopped', code: EXIT.failed });
    assert.deepEqual(said, ["FAILED the new task's issue: no token saved for acme; nothing is written"]);
    assert.deepEqual([host.calls, register.adds], [[], []]);
  });

  it('writes nothing when the issue fails to open', async () => {
    const register = new FakeAddRegister();
    const host = fittingHost().failsOpen('HTTP 502');
    const { end, said } = await run(register, host);
    assert.deepEqual(end, { kind: 'stopped', code: EXIT.failed });
    assert.deepEqual(said, ["FAILED the new task's issue: HTTP 502; nothing is written"]);
    assert.deepEqual(register.adds, []);
  });

  it('writes the task with its ref pointing at the issue just opened', async () => {
    const register = new FakeAddRegister();
    const host = new FakeIssueHost();
    const { end } = await run(register, host);
    assert.equal(end.kind === 'written' ? end.ref : end.kind, 'gh:acme/web#1');
    assert.deepEqual(register.adds, [{ ...INPUT, ref: 'gh:acme/web#1' }]);
  });

  it('opens the issue with the type, status and area labels the judged task calls for, as a task just added (T3349)', async () => {
    const register = new FakeAddRegister({ ok: true, value: testTask({ type: 'bug', owner: 'alpha', status: 'in-progress' }) });
    const host = fittingHost();
    const { said } = await run(register, host);
    assert.deepEqual(host.calls[0], { kind: 'open', draft: { ...DRAFT, type: 'Bug', labels: ['status:open', 'area:sync'], assignees: [] } });
    assert.deepEqual(said, ['CLOSED gh:acme/web#1 as not planned: the task it opened for was refused']);
  });

  it('closes the issue as not planned when the write is refused after it opened', async () => {
    const register = new FakeAddRegister();
    const host = fittingHost();
    const { end, said } = await run(register, host);
    assert.equal(end.kind === 'written' && !end.verdict.ok ? end.verdict.error : 'written', 'T1 already tracks this (open, owner alpha)');
    assert.deepEqual(host.calls.at(-1), { kind: 'close', target: { repo: 'acme/web', number: 1 }, reason: 'not-planned' });
    assert.deepEqual(said, ['CLOSED gh:acme/web#1 as not planned: the task it opened for was refused']);
  });

  it('says to close the issue by hand when that close fails too', async () => {
    const register = new FakeAddRegister();
    const host = fittingHost().failsClose('HTTP 403');
    const { said } = await run(register, host);
    assert.deepEqual(said, ['FAILED to close gh:acme/web#1: HTTP 403; close it by hand, the task it opened for was refused']);
  });
});
