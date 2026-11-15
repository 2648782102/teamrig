import { openKit, type KitReader } from '../../src/cli/kit.ts';
import { RefusedError } from '../../src/cli/runtime.ts';
import { ENV, type Env } from '../../src/core/home.ts';
import { targetText } from '../../src/issues/host.ts';
import { refTarget } from '../../src/issues/links.ts';
import type { Task } from '../../src/register/fold.ts';
import { JsonlEventLog } from '../../src/register/store.ts';
import { taskOfBranch } from './approval.ts';

/**
 * The issue a branch's pull request closes (T3132 step 3): the one its task's ref names (`gh:owner/name#n`), as the
 * `Closes owner/name#n` line GitHub closes it by on the merge, so the issue follows the work with no hand step; else
 * why there is none, which the merge prints as a NOTE and leaves out of the body.
 */
export type ClosingIssue = { readonly kind: 'closes'; readonly line: string } | { readonly kind: 'none'; readonly why: string };

/** The issue `branch`'s pull request closes, read from its task `task` (undefined when the register holds none). */
export function closingIssue(branch: string, taskId: string | null, task: Pick<Task, 'ref'> | undefined): ClosingIssue {
  if (taskId === null) {
    return { kind: 'none', why: `branch ${branch} names no task` };
  }
  if (task === undefined) {
    return { kind: 'none', why: `the register holds no task ${taskId}` };
  }
  const target = refTarget(task);
  if (target === undefined) {
    return { kind: 'none', why: `${taskId} has no issue ref (gh:owner/name#n)` };
  }
  // The full owner/name form closes the issue from a pull request of any repository the merger can write to.
  return { kind: 'closes', line: `Closes ${targetText(target)}` };
}

/** The issue the pull request of `branch` closes. */
export type ClosingIssueOf = (branch: string) => Promise<ClosingIssue>;

/** Reads task `taskId` of team `team` from its register; undefined when it holds none, `RefusedError` when it cannot. */
export type TaskOf = (team: string, taskId: string) => Promise<Pick<Task, 'ref'> | undefined>;

/**
 * `closingIssue` for `branch` on the register of `team` (`$TEAMRIG_TEAM`), read through `taskOf`. A register that
 * cannot be read (a `RefusedError`) gives none with its reason, since the merge was cleared already and a missing
 * line only leaves the issue open; any other failure goes through.
 */
export async function closingIssueOn(team: string | undefined, taskOf: TaskOf, branch: string): Promise<ClosingIssue> {
  const taskId = taskOfBranch(branch);
  if (taskId === null) {
    return closingIssue(branch, null, undefined);
  }
  if (team === undefined || team === '') {
    return { kind: 'none', why: 'TEAMRIG_TEAM names no team to read the register of' };
  }
  try {
    return closingIssue(branch, taskId, await taskOf(team, taskId));
  } catch (error) {
    if (error instanceof RefusedError) {
      return { kind: 'none', why: error.message };
    }
    throw error;
  }
}

/** `closingIssueOn` for the team `env` names, reading its register through `reader`. */
export function closingIssueFrom(env: Env, reader: KitReader): ClosingIssueOf {
  const team = env[ENV.team]?.trim();
  const taskOf: TaskOf = async (name, taskId) => {
    const kit = await openKit(reader, name);
    const { state } = await new JsonlEventLog(reader.files, kit.paths.events).read();
    return state.tasks.get(taskId);
  };
  return (branch) => closingIssueOn(team, taskOf, branch);
}
