import { createHash } from 'node:crypto';
import { openKit, type KitReader } from '../../src/cli/kit.ts';
import { RefusedError } from '../../src/cli/runtime.ts';
import { mergeStandingOf, type MergeStanding } from '../../src/cli/ship-approval.ts';
import { ENV, type Env } from '../../src/core/home.ts';
import { PlainLogFile } from '../../src/core/log-file.ts';
import { JsonlMarkLog } from '../../src/inbox/store.ts';
import { approvedTaskOf } from '../../src/register/approval.ts';

/**
 * Whether a merge may go ahead (T2788, security verdict on T2763): refused with why; the caller's own say (a root
 * team's lead, whom nobody approves); or the approval of `by`, one of the caller's leaders, given in the register.
 */
export type MergeClearance =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'approved'; readonly by: string };

const BRANCH_TASK = /^t(\d+)-/;
const SHA = /^[0-9a-f]{7,40}$/;
const SHA_RUN = /\b[0-9a-f]{7,40}\b/g;

/** The task a branch is cut for, from its `t<id>-` prefix (`t2788-ship-approval` → `T2788`); null for any other name. */
export function taskOfBranch(branch: string): string | null {
  const match = BRANCH_TASK.exec(branch);
  return match === null ? null : `T${match[1]}`;
}

const refused = (reason: string): MergeClearance => ({ kind: 'refused', reason });

/**
 * Whether `standing.caller` may merge `head`, the branch tip of task `taskId`, on the approval it names (`--approved`).
 * In order:
 * - the task must exist and be the caller's own: only the session that made a change merges it (rule 2), the lead too;
 * - a caller nobody approves (a root team's lead) clears itself;
 * - else `approved` must be a sha `head` starts with, the task must hold one of its approvers' approval
 *   (`approvedTaskOf`, as the push guard reads it), and that answer's note must name a sha `head` starts with, so an
 *   approval of an earlier head never clears a later one.
 */
export function mergeClearance(standing: MergeStanding, taskId: string, head: string, approved: string | null): MergeClearance {
  const { caller, task, approvers } = standing;
  if (task === undefined) {
    return refused(`the register holds no task ${taskId}, the branch's task`);
  }
  if (task.owner !== caller) {
    return refused(`${taskId} is ${task.owner}'s: only its owner merges it, not ${caller}`);
  }
  if (approvers.length === 0) {
    return { kind: 'self' };
  }
  if (approved === null) {
    return refused(`name the approved head with --approved <sha>: ${caller}'s merge needs the approval of ${approvers.join(' or ')}`);
  }
  if (!SHA.test(approved) || !head.startsWith(approved)) {
    return refused(`--approved ${approved} is not the branch head ${head}`);
  }
  const answered = approvedTaskOf([task], caller, approvers);
  if (answered === undefined) {
    return refused(`${taskId} (${task.status}) holds no approval of ${approvers.join(' or ')}: set it waiting approval:${approvers[0]} and ask for it naming ${head}`);
  }
  const named = task.answer?.note?.match(SHA_RUN) ?? [];
  if (!named.some((sha) => head.startsWith(sha))) {
    return refused(`${answered.by}'s approval of ${taskId} names no sha of the head ${head}: ask ${answered.by} to approve naming it`);
  }
  return { kind: 'approved', by: answered.by };
}

/**
 * Who a merge runs for: its team (`$TEAMRIG_TEAM`), the Claude Code tab it runs from (`$CLAUDE_CODE_SESSION_ID`) and
 * the session the caller says it is (`$TEAMRIG_SESSION`, optional). The caller is the session the tab is bound to,
 * never the claim alone (security T2979 F3): a claim set to a root team's lead would clear its own merge.
 */
export interface MergeCaller {
  readonly team: string | undefined;
  readonly tab: string | undefined;
  readonly claimed: string | undefined;
}

/** Reads a merge's standing from the register (`mergeStandingOf`); rejects with `RefusedError` when it cannot. */
export type StandingOf = (team: string, caller: string, taskId: string) => Promise<MergeStanding>;

/** The session Claude Code tab `tab` is bound to on team `team` (the one its inbox marks name), or undefined when none is. */
export type TabSessionOf = (team: string, tab: string) => Promise<string | undefined>;

/** What `clearMerge` reads: the tab's binding and the register's standing of the caller. */
export interface MergeLookups {
  readonly tabSessionOf: TabSessionOf;
  readonly standingOf: StandingOf;
}

const setOrUndefined = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

/**
 * The clearance of a merge of `branch` at `head`: refused when the branch names no task, the team or tab is not set,
 * the tab is bound to no session of the team, the claimed session is not the tab's, or the register cannot be read
 * for them (a `RefusedError`, its message kept); else `mergeClearance` of the tab's session.
 */
export async function clearMerge(caller: MergeCaller, lookups: MergeLookups, branch: string, head: string, approved: string | null): Promise<MergeClearance> {
  const taskId = taskOfBranch(branch);
  if (taskId === null) {
    return refused(`branch ${branch} names no task: a merged branch is t<id>-<name>`);
  }
  const team = setOrUndefined(caller.team);
  const tab = setOrUndefined(caller.tab);
  if (team === undefined || tab === undefined) {
    return refused(`${ENV.team} and ${ENV.claudeSession} must name the merging team and the Claude Code tab it runs from`);
  }
  let standing: MergeStanding;
  try {
    const bound = await lookups.tabSessionOf(team, tab);
    if (bound === undefined) {
      return refused(`this Claude Code tab is bound to no session of ${team}: a session merges from its own tab`);
    }
    // A claim is read as a name or id; the register resolves it, and it must be the tab's own session.
    standing = await lookups.standingOf(team, setOrUndefined(caller.claimed) ?? bound, taskId);
    if (standing.caller !== bound) {
      return refused(`this tab is ${bound}'s: a session merges only as itself, not as ${standing.caller}`);
    }
  } catch (error) {
    if (error instanceof RefusedError) {
      return refused(error.message);
    }
    throw error;
  }
  return mergeClearance(standing, taskId, head, approved);
}

/**
 * The session tab `tab` is bound to on team `team`: the one session every inbox mark of the tab names. A typed
 * `teamrig inbox read --session <any>` appends a mark naming what it was told, so the newest mark alone would let a tab
 * become any session (security T2987 F1); a tab whose marks name two sessions is refused (`RefusedError`) instead.
 */
export async function tabSessionFrom(reader: KitReader, team: string, tab: string): Promise<string | undefined> {
  const kit = await openKit(reader, team);
  const { marks } = await new JsonlMarkLog(new PlainLogFile(reader.files, kit.paths.inboxMarks)).read();
  const areas = [...new Set(marks.filter((mark) => mark.claudeSession === tab).map((mark) => mark.area))];
  if (areas.length > 1) {
    throw new RefusedError(`this tab read more than one session's inbox (${areas.sort().join(', ')}): merge from a fresh tab`);
  }
  return areas[0];
}

/** The clearance of a merge of `branch` at `head`, on the approved sha the caller names (`--approved`) or null. */
export type ClearMerge = (branch: string, head: string, approved: string | null) => Promise<MergeClearance>;

/**
 * `clearMerge` for the team, tab and claim `env` names (`$TEAMRIG_TEAM`, `$CLAUDE_CODE_SESSION_ID`,
 * `$TEAMRIG_SESSION`), reading the tab's binding and the register through `reader`. A session name, typed in the env
 * or in an inbox read's `--session`, clears no one but the tab's own session: a tab that read two sessions' inboxes is
 * refused. Faking the caller takes another tab's Claude Code session id; the guard stays the trust boundary.
 */
export function clearMergeFrom(env: Env, reader: KitReader): ClearMerge {
  const caller = { team: env[ENV.team]?.trim(), tab: env[ENV.claudeSession]?.trim(), claimed: env[ENV.session]?.trim() };
  const lookups: MergeLookups = {
    tabSessionOf: (team, tab) => tabSessionFrom(reader, team, tab),
    standingOf: (team, session, taskId) => mergeStandingOf(reader, team, session, taskId),
  };
  return (branch, head, approved) => clearMerge(caller, lookups, branch, head, approved);
}

/** Runs git in the repo and returns its stdout; throws when git fails. */
export type GitText = (args: readonly string[]) => string;

/**
 * The fingerprint of what `rev` changes over `mainRef`, the paths in `regenerated` apart (a folder ends in `/`): the
 * sha256 of its zero-context diff from their merge base, with blob ids and hunk positions dropped, so a rebase over
 * other lines keeps it and any change to the branch's own lines moves it. A merge checks the branch it pushes against
 * the fingerprint of the head its approver named.
 */
export function changePatch(git: GitText, rev: string, mainRef: string, regenerated: readonly string[]): string {
  const from = git(['merge-base', rev, mainRef]).trim();
  const excluded = regenerated.map((path) => `:(exclude)${path}`);
  const diff = git(['diff', '--unified=0', '--no-renames', '--no-color', '--no-ext-diff', from, rev, '--', '.', ...excluded]);
  const normalized = diff
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}
