import { createHash } from 'node:crypto';
import type { KitReader } from '../../src/cli/kit.ts';
import { RefusedError } from '../../src/cli/runtime.ts';
import { mergeStandingOf, tabCallerOf, type MergeStanding } from '../../src/cli/ship-approval.ts';
import { ENV, type Env } from '../../src/core/home.ts';
import { reviewPathMatcher } from '../../src/push-guard/review-paths.ts';
import { approvedTaskOf } from '../../src/register/approval.ts';
import type { Task } from '../../src/register/fold.ts';
import { branchTaskOf } from '../../src/worktree/owner.ts';
import { TEAMRIG_VERSION_FILES, type VersionFile } from './version-bump.ts';

/**
 * Whether a merge may go ahead (T2788, security verdict on T2763): refused with why; the caller's own say (a root
 * team's lead, whom nobody approves); the approval of `by`, one of the caller's leaders, given in the register; or
 * `low-risk` (owner order, T3448): the GitHub answerer `by` approved the head itself, and none of its `paths` is
 * sensitive.
 */
export type MergeClearance =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'self' }
  | { readonly kind: 'approved'; readonly by: string }
  | { readonly kind: 'low-risk'; readonly by: string; readonly paths: number };

/** How a merge that may go ahead was cleared, as its log line says it. */
export function clearanceText(clearance: Exclude<MergeClearance, { kind: 'refused' }>): string {
  switch (clearance.kind) {
    case 'self':
      return "the caller's own, a root team's lead";
    case 'approved':
      return `approved by ${clearance.by}`;
    case 'low-risk':
      return `low-risk, approved by ${clearance.by}, the GitHub answerer: ${clearance.paths} changed path(s), none sensitive`;
  }
}

const SHA = /^[0-9a-f]{7,40}$/;
const SHA_RUN = /\b[0-9a-f]{7,40}\b/g;
/** How many sensitive paths a refusal names before it counts the rest. */
const NAMED_PATHS = 5;

/**
 * The task a branch is cut for, read as the plugin reads it (`branchTaskOf`), so a branch `teamrig worktree add --task`
 * names by delivery.branches (`fix/t3164-rate-fit`) merges too (T3193); null for a branch named for no task.
 */
export function taskOfBranch(branch: string): string | null {
  return branchTaskOf(branch) ?? null;
}

const refused = (reason: string): MergeClearance => ({ kind: 'refused', reason });

/**
 * Whether `standing.caller` may merge `head`, the branch tip of task `taskId`, on the approval it names (`--approved`).
 * In order:
 * - the task must exist and be the caller's own: only the session that made a change merges it (rule 2), the lead too;
 * - a caller nobody approves (a root team's lead) clears itself;
 * - else `approved` must be a sha `head` starts with, the task must hold one of its approvers' approval
 *   (`approvedTaskOf`, as the push guard reads it), and that answer's note must name a sha `head` starts with, so an
 *   approval of an earlier head never clears a later one;
 * - failing that, the GitHub answerer's merge reads the paths its head changes (`reads`, only then) and is cleared by
 *   `answererClearance` (owner order, T3448).
 */
export function mergeClearance(standing: MergeStanding, taskId: string, head: string, approved: string | null, reads: ChangeReads): MergeClearance {
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
  const named = task.answer?.note?.match(SHA_RUN) ?? [];
  if (answered !== undefined && named.some((sha) => head.startsWith(sha))) {
    return { kind: 'approved', by: answered.by };
  }
  const unapproved =
    answered === undefined
      ? `${taskId} (${task.status}) holds no approval of ${approvers.join(' or ')}: set it waiting approval:${approvers[0]} and ask for it naming ${head}`
      : `${answered.by}'s approval of ${taskId} names no sha of the head ${head}: ask ${answered.by} to approve naming it`;
  if (caller !== standing.answerer) {
    return refused(unapproved);
  }
  const paths = reads.changedPaths(head);
  return answererClearance(standing, task, head, unapproved, {
    paths: paths.length,
    sensitive: sensitivePathsOf(paths, standing),
    overlaps: overlapsOf(paths, openBranchesOf(reads, standing, taskId)),
  });
}

/** What the GitHub answerer's head touches (T3448): how many paths, the sensitive ones, and the other sessions' open branches it overlaps. */
export interface AnswererChange {
  readonly paths: number;
  readonly sensitive: readonly string[];
  readonly overlaps: readonly Overlap[];
}

/**
 * The GitHub answerer's clearance of its own head, which no leader approved (owner order, T3448): alone, by its own
 * `--approved`, when the head touches no sensitive path and no file another session's open branch changes; else the
 * one session that must approve the head first, the security reviewer for a sensitive path or the session whose open
 * branch it overlaps, by an approval naming the head. Several such sessions, or a sensitive path in a team with no
 * other security reviewer, are the leaders' to approve: a task holds one answer at a time.
 */
export function answererClearance(standing: MergeStanding, task: Task, head: string, unapproved: string, change: AnswererChange): MergeClearance {
  const { caller, securityReviewer } = standing;
  const { sensitive, overlaps } = change;
  const sensitiveText = `the sensitive ${pathsText(sensitive)}`;
  if (overlaps.length > 1) {
    return refused(`${unapproved}; it touches files of several sessions' open branches (${overlaps.map(overlapText).join('; ')}), which the leaders approve`);
  }
  if (sensitive.length > 0 && (securityReviewer === undefined || securityReviewer === caller)) {
    return refused(`${unapproved}; it touches ${sensitiveText}, and the team has no other security reviewer to pass it first`);
  }
  const needs = [
    ...(sensitive.length > 0 && securityReviewer !== undefined ? [{ who: securityReviewer, why: sensitiveText }] : []),
    ...overlaps.map((overlap) => ({ who: overlap.owner, why: overlapText(overlap) })),
  ];
  const [first, ...rest] = needs;
  if (first === undefined) {
    return { kind: 'low-risk', by: caller, paths: change.paths };
  }
  if (rest.some((need) => need.who !== first.who)) {
    return refused(`${unapproved}; it touches ${needs.map((need) => need.why).join(' and ')}, which the leaders approve`);
  }
  const answered = approvedTaskOf([task], caller, [first.who]);
  const named = task.answer?.note?.match(SHA_RUN) ?? [];
  if (answered !== undefined && named.some((sha) => head.startsWith(sha))) {
    return { kind: 'approved', by: answered.by };
  }
  const why = needs.map((need) => need.why).join(' and ');
  return refused(`${task.id} touches ${why}: set it waiting approval:${first.who} and ask ${first.who} to approve it naming ${head} (a leader's approval of it clears it too)`);
}

/** Paths in a refusal: the first five, then a count of the rest. */
function pathsText(paths: readonly string[]): string {
  const more = paths.length > NAMED_PATHS ? ` and ${paths.length - NAMED_PATHS} more` : '';
  return `${paths.slice(0, NAMED_PATHS).join(', ')}${more}`;
}

function overlapText(overlap: Overlap): string {
  return `${pathsText(overlap.paths)}, which ${overlap.owner}'s open ${overlap.tasks.join(', ')} change${overlap.tasks.length > 1 ? '' : 's'}`;
}

/** A branch of another session's open task, and the paths it changes over main. */
export interface OpenBranch {
  readonly task: string;
  readonly owner: string;
  readonly paths: readonly string[];
}

/** The paths of the head that one other session's open branches change too, and those branches' tasks. */
export interface Overlap {
  readonly owner: string;
  readonly tasks: readonly string[];
  readonly paths: readonly string[];
}

/**
 * The open branches of other sessions' tasks (T3448): each branch of the repo, local or origin's, named for a task the
 * register holds unshipped (`standing.open`) that is neither the merging task nor the caller's, with the paths it
 * changes, read only for those.
 */
export function openBranchesOf(reads: ChangeReads, standing: Pick<MergeStanding, 'caller' | 'open'>, taskId: string): readonly OpenBranch[] {
  return reads.taskBranches().flatMap(({ task, ref }) => {
    const owner = standing.open.get(task);
    return owner === undefined || owner === standing.caller || task === taskId ? [] : [{ task, owner, paths: reads.changedPaths(ref) }];
  });
}

/** The head's `paths` that `branches` change too, one entry per owner in branch order, its tasks and paths each once. */
export function overlapsOf(paths: readonly string[], branches: readonly OpenBranch[]): readonly Overlap[] {
  const head = new Set(paths);
  const byOwner = new Map<string, { tasks: Set<string>; paths: Set<string> }>();
  for (const branch of branches) {
    const shared = branch.paths.filter((path) => head.has(path));
    if (shared.length === 0) {
      continue;
    }
    const entry = byOwner.get(branch.owner) ?? { tasks: new Set<string>(), paths: new Set<string>() };
    entry.tasks.add(branch.task);
    shared.forEach((path) => entry.paths.add(path));
    byOwner.set(branch.owner, entry);
  }
  return [...byOwner].map(([owner, entry]) => ({ owner, tasks: [...entry.tasks], paths: [...entry.paths] }));
}

/** A branch of the repo named for a task (`taskOfBranch`), by its full ref. */
export interface TaskBranch {
  readonly task: string;
  readonly ref: string;
}

/** The repo's local and origin's branches named for a task, read by `git for-each-ref`. */
export function taskBranchesOf(git: GitText): readonly TaskBranch[] {
  return git(['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/origin/'])
    .split('\n')
    .flatMap((ref) => {
      const task = taskOfBranch(ref.trim());
      return task === null ? [] : [{ task, ref: ref.trim() }];
    });
}

/**
 * The repo reads of a merge's clearance: `changedPathsOf` a rev over origin's `main`, less the folders the repo's build
 * regenerates (`regenerated`, its repos.json profile), as the approval hash reads the same head (`changePatch`); and
 * its task branches (`taskBranchesOf`).
 */
export function repoChanges(git: GitText, main: string, regenerated: readonly string[]): ChangeReads {
  return {
    changedPaths: (rev) => changedPathsOf(git, rev, `refs/remotes/origin/${main}`, shipWritesOf(regenerated, TEAMRIG_VERSION_FILES).generated),
    taskBranches: () => taskBranchesOf(git),
  };
}

/**
 * The sensitive paths among `paths` (T3448, security verdict): each that matches no low-risk glob, or matches a sensitive
 * one, read as the review gate reads its entries (`reviewPathMatcher`). An allow list, so a path nobody listed is
 * sensitive; the sensitive globs carve out of it what no team's low-risk folder may clear.
 */
export function sensitivePathsOf(paths: readonly string[], globs: Pick<MergeStanding, 'lowRisk' | 'sensitive'>): readonly string[] {
  const lowRisk = globs.lowRisk.map(reviewPathMatcher);
  const sensitive = globs.sensitive.map(reviewPathMatcher);
  return paths.filter((path) => !lowRisk.some((matches) => matches(path)) || sensitive.some((matches) => matches(path)));
}

/**
 * The repo paths `rev` changes over its merge base with `mainRef` (T3448), listed as the review gate lists a change
 * (`--name-only --no-renames`, so a rename names its old and its new path and a deletion its path), less the folders
 * the build regenerates, which every approval hash leaves out too (`changePatch`). `-z` keeps a path with an odd
 * character whole and unquoted, so the matchers read it as git stores it.
 */
export function changedPathsOf(git: GitText, rev: string, mainRef: string, generated: readonly string[]): readonly string[] {
  const from = git(['merge-base', rev, mainRef]).trim();
  return git(['diff', '--name-only', '-z', '--no-renames', from, rev, '--', '.', ...excludedOf(generated)])
    .split('\0')
    .filter((path) => path !== '');
}

/** The caller and team a merge runs for, from `$TEAMRIG_SESSION` and `$TEAMRIG_TEAM`, and its tab, from `$CLAUDE_CODE_SESSION_ID`. */
export interface MergeCaller {
  readonly session: string | undefined;
  readonly team: string | undefined;
  readonly claudeSession: string | undefined;
}

/** Reads a merge's standing from the register (`mergeStandingOf`); rejects with `RefusedError` when it cannot. */
export type StandingOf = (team: string, caller: string, taskId: string) => Promise<MergeStanding>;

/** The session the merging tab is bound to, which must be the one the caller names (`tabCallerOf`); rejects with `RefusedError` otherwise. */
export type TabCallerOf = (team: string, claudeSession: string, caller: string) => Promise<string>;

/** What the GitHub answerer's clearance reads of the repo (T3448): the paths a rev changes over main, and the branches named for a task. */
export interface ChangeReads {
  readonly changedPaths: (rev: string) => readonly string[];
  readonly taskBranches: () => readonly TaskBranch[];
}

/** What a merge's clearance reads: the tab's session, then that session's standing, then, for the GitHub answerer, the repo. */
export interface MergeReads {
  readonly tabCallerOf: TabCallerOf;
  readonly standingOf: StandingOf;
  readonly changes: ChangeReads;
}

/**
 * The clearance of a merge of `branch` at `head`: refused when the branch names no task, the caller, team or tab is
 * not set, the tab is not bound to the caller alone (T2984, security condition C4), or the register cannot be read for
 * them (a `RefusedError`, its message kept); else `mergeClearance`.
 */
export async function clearMerge(caller: MergeCaller, reads: MergeReads, branch: string, head: string, approved: string | null): Promise<MergeClearance> {
  const taskId = taskOfBranch(branch);
  if (taskId === null) {
    return refused(`branch ${branch} names no task: a merged branch is t<id>-<name>`);
  }
  if (caller.session === undefined || caller.session === '' || caller.team === undefined || caller.team === '') {
    return refused('TEAMRIG_SESSION and TEAMRIG_TEAM must name the merging session and its team');
  }
  if (caller.claudeSession === undefined || caller.claudeSession === '') {
    return refused("CLAUDE_CODE_SESSION_ID must name the merging Claude Code tab: a merge runs from the merging session's own tab");
  }
  let standing: MergeStanding;
  try {
    const session = await reads.tabCallerOf(caller.team, caller.claudeSession, caller.session);
    standing = await reads.standingOf(caller.team, session, taskId);
  } catch (error) {
    if (error instanceof RefusedError) {
      return refused(error.message);
    }
    throw error;
  }
  return mergeClearance(standing, taskId, head, approved, reads.changes);
}

/** The clearance of a merge of `branch` at `head`, on the approved sha the caller names (`--approved`) or null. */
export type ClearMerge = (branch: string, head: string, approved: string | null) => Promise<MergeClearance>;

/**
 * `clearMerge` for the session, team and tab `env` names (`$TEAMRIG_SESSION`, `$TEAMRIG_TEAM`,
 * `$CLAUDE_CODE_SESSION_ID`), reading the inbox marks and the register through `reader`. The session must be the one
 * the tab is bound to, so a typed name merges no other session's task; the marks are files of the shared account
 * (stopgap T791), so the guards stay the trust boundary. `changes` reads the repo for the GitHub answerer's clearance.
 */
export function clearMergeFrom(env: Env, reader: KitReader, changes: ChangeReads): ClearMerge {
  const caller = { session: env[ENV.session]?.trim(), team: env[ENV.team]?.trim(), claudeSession: env[ENV.claudeSession]?.trim() };
  const reads: MergeReads = {
    tabCallerOf: (team, claudeSession, session) => tabCallerOf(reader, team, claudeSession, session),
    standingOf: (team, session, taskId) => mergeStandingOf(reader, team, session, taskId),
    changes,
  };
  return (branch, head, approved) => clearMerge(caller, reads, branch, head, approved);
}

/** Runs git in the repo and returns its stdout; throws when git fails. */
export type GitText = (args: readonly string[]) => string;

/**
 * The paths a ship writes again on every run, split by how an approval hashes them (security verdict T2914, F1):
 * - `generated`: folders the build empties and rebuilds (each ends in `/`), left out of every hash, since no
 *   committed edit in them survives to the push;
 * - `versionFiles`: files of which the ship rewrites only the version token, hashed with that token masked, so a
 *   version raise drops out while any other edit (code in version.ts, a hooks key in plugin.json) counts as work.
 */
export interface ShipWrites {
  readonly generated: readonly string[];
  readonly versionFiles: readonly VersionFile[];
}

/**
 * Splits a repo profile's regenerated paths (repos.json) into `ShipWrites`, a file by the version files the ship
 * knows (`known`). Throws on a file that is neither a folder nor a known version file: leaving it out of the hash
 * would let any edit to it ship on an earlier approval.
 */
export function shipWritesOf(regenerated: readonly string[], known: readonly VersionFile[]): ShipWrites {
  const generated: string[] = [];
  const versionFiles: VersionFile[] = [];
  for (const path of regenerated) {
    const file = known.find((one) => one.path === path);
    if (file !== undefined) versionFiles.push(file);
    else if (path.endsWith('/')) generated.push(path);
    else throw new Error(`regenerated path ${path} is no folder the build rebuilds and no version file the ship rewrites: an approval cannot skip it`);
  }
  return { generated, versionFiles };
}

/**
 * The options every hashed diff runs with: no rename pairing, colour or external diff, and every path diffed as text
 * with no textconv (security verdict T2914, F2), so a binary path, or one a .gitattributes line marks -diff, is hashed
 * by its content, never by a "Binary files differ" line that any swap keeps.
 */
const DIFF_OPTIONS = ['--no-renames', '--no-color', '--no-ext-diff', '--text', '--no-textconv'] as const;

/**
 * The fingerprint of what `rev` changes over `mainRef`, read as `writes` says: the sha256 of its zero-context diff
 * from their merge base, with blob ids, hunk positions and version tokens dropped, so a rebase over other lines keeps
 * it and any change to the branch's own lines moves it. A merge checks the branch it pushes against the fingerprint
 * of the head its approver named.
 */
export function changePatch(git: GitText, rev: string, mainRef: string, writes: ShipWrites): string {
  const from = git(['merge-base', rev, mainRef]).trim();
  return diffHash(git(['diff', '--unified=0', ...DIFF_OPTIONS, from, rev, '--', '.', ...excludedOf(writes.generated)]), writes.versionFiles);
}

const excludedOf = (generated: readonly string[]): string[] => generated.map((path) => `:(exclude)${path}`);

/** A diff's sections, each version file's masked (`maskedSection`); a version-only change leaves no line. */
function normalizedOf(diff: string, versionFiles: readonly VersionFile[]): string[] {
  return sectionsOf(diff.split('\n')).flatMap((section) => {
    const file = versionFiles.find((one) => section[0] === `diff --git a/${one.path} b/${one.path}`);
    return file === undefined ? section : maskedSection(section, file);
  });
}

/**
 * The sha256 of a diff with its blob ids and hunk positions dropped, so moving the lines it changes keeps it, and
 * each version file's version token masked.
 */
function diffHash(diff: string, versionFiles: readonly VersionFile[]): string {
  const normalized = normalizedOf(diff, versionFiles)
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/** A diff's lines cut into one list per file, each starting at its `diff --git` line. */
function sectionsOf(lines: readonly string[]): string[][] {
  const sections: string[][] = [];
  for (const line of lines) {
    const last = sections.at(-1);
    if (line.startsWith('diff --git ') || last === undefined) sections.push([line]);
    else last.push(line);
  }
  return sections;
}

/**
 * A version file's diff section with its version token masked on every line, less each hunk that changes nothing but
 * that token (its removed and added lines equal once masked); no line at all when no hunk is left, as for a commit
 * that only raises the version.
 */
function maskedSection(section: readonly string[], file: VersionFile): string[] {
  const token = new RegExp(file.pattern.source, `${file.pattern.flags.replace('g', '')}g`);
  const masked = section.map((line) => line.replace(token, (_match, before: string, _version: string, after: string) => `${before}<version>${after}`));
  const first = masked.findIndex((line) => line.startsWith('@@'));
  if (first === -1) return masked;
  const hunks: string[][] = [];
  for (const line of masked.slice(first)) {
    const last = hunks.at(-1);
    if (line.startsWith('@@') || last === undefined) hunks.push([line]);
    else last.push(line);
  }
  const kept = hunks.filter((hunk) => !changesNothing(hunk));
  return kept.length === 0 ? [] : [...masked.slice(0, first), ...kept.flat()];
}

/** Whether a hunk's removed lines are its added lines, in order. */
function changesNothing(hunk: readonly string[]): boolean {
  const side = (mark: string): string[] => hunk.slice(1).filter((line) => line.startsWith(mark)).map((line) => line.slice(1));
  const removed = side('-');
  const added = side('+');
  return removed.length === added.length && removed.every((line, i) => line === added[i]);
}

/** One commit a branch carries over main. */
export interface WorkCommit {
  readonly sha: string;
  readonly subject: string;
  /** A merge commit, whose own changes no patch shows. */
  readonly merge: boolean;
  /**
   * The commit's patch id, like `git patch-id` (what `git range-diff` marks `=`): the hash of its diff with 3 lines of
   * context, blob ids and hunk positions dropped, so a rebase over other lines keeps it; whitespace counts, unlike in
   * git's, so a whitespace edit moves it too. Empty for a merge commit.
   */
  readonly patch: string;
}

/**
 * The work commits `rev` carries over `mainRef`, oldest first: every commit not on main whose diff, read as `writes`
 * says, changes anything, with its patch id, and every merge commit. A commit that only rebuilds a generated folder or
 * raises the version is no work commit: a ship sets those again each run.
 */
export function workCommitsOf(git: GitText, rev: string, mainRef: string, writes: ShipWrites): WorkCommit[] {
  const rows = git(['rev-list', '--reverse', '--parents', rev, `^${mainRef}`]).split('\n').filter((row) => row.trim() !== '');
  return rows.flatMap((row): WorkCommit[] => {
    const [sha = '', ...parents] = row.trim().split(' ');
    const subject = (): string => git(['log', '-1', '--format=%s', sha]).trim();
    if (parents.length > 1) return [{ sha, subject: subject(), merge: true, patch: '' }];
    const diff = git(['diff-tree', '-p', '-r', '--root', '--no-commit-id', '--unified=3', ...DIFF_OPTIONS, sha, '--', '.', ...excludedOf(writes.generated)]);
    const changes = normalizedOf(diff, writes.versionFiles).some((line) => line.trim() !== '');
    return changes ? [{ sha, subject: subject(), merge: false, patch: diffHash(diff, writes.versionFiles) }] : [];
  });
}

const named = (commit: WorkCommit): string => `${commit.sha.slice(0, 9)} "${commit.subject}"`;

/**
 * How `head`'s work commits differ from `approved`'s, each change named (changed, dropped, added, reordered); empty
 * when they are the same patches in the same order, all a rebase leaves that `git range-diff` marks `=` throughout.
 * A merge commit on either side always differs: its own changes have no patch to compare.
 */
export function workChanges(approved: readonly WorkCommit[], head: readonly WorkCommit[]): string[] {
  const merges = [...approved, ...head].filter((commit) => commit.merge).map((commit) => `merge commit ${named(commit)}: rebase it away`);
  const unmatched = head.filter((commit) => !commit.merge);
  const missing: WorkCommit[] = [];
  for (const commit of approved.filter((one) => !one.merge)) {
    const at = unmatched.findIndex((other) => other.patch === commit.patch);
    if (at === -1) missing.push(commit);
    else unmatched.splice(at, 1);
  }
  const changes = [...merges];
  for (const commit of missing) {
    const at = unmatched.findIndex((other) => other.subject === commit.subject);
    if (at === -1) {
      changes.push(`dropped ${named(commit)}`);
    } else {
      changes.push(`changed ${named(commit)}, now ${unmatched[at]?.sha.slice(0, 9) ?? ''}`);
      unmatched.splice(at, 1);
    }
  }
  changes.push(...unmatched.map((commit) => `added ${named(commit)}`));
  if (changes.length === 0 && approved.some((commit, i) => commit.patch !== head[i]?.patch)) {
    changes.push(`reordered, now ${head.map((commit) => commit.sha.slice(0, 9)).join(', ')}`);
  }
  return changes;
}
