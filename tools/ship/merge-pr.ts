import { homedir } from 'node:os';
import { nodeFiles } from '../../src/core/files.ts';
import { realSleep, systemClock } from '../../src/core/lock.ts';
import { type ClearPull, clearPullFrom } from './approval.ts';
import { freeBranch } from './branch-names.ts';
import type { Gh } from './github.ts';
import { booleanAt, isRecord, recordAt, recordOf, stringAt } from './json.ts';
import { isRegenerated } from './leftovers.ts';
import { MERGE_ATTEMPTS, type MainBranch, type MergeDeps, type RepoFiles, mainBranchOf, mergeProvenPull, mergeRun, proofFor, realMergeDeps, realRepoFiles } from './merge.ts';
import { type PullRequest, parsePull } from './pulls.ts';
import { pushOwnBranch } from './push.ts';
import { type Regeneration, type ReplayPlan, listedPaths, regenerate, regenerationFor } from './regenerate.ts';
import { type RepoProfile, profileFor, slugOf } from './repos.ts';
import { APPROVED_SHA } from './ship-plan.ts';
import { TRAILER } from './ship-commits.ts';
import { describeCredential } from './token-check.ts';
import { type BumpKind, bumped, compareVersions, formatVersion, versionIn } from './version-bump.ts';

/**
 * `ship.ts merge-pr`: merges a contributor's pull request as it is (the T3021 design, section 5), then cuts and merges
 * the release pull request that raises the plugin version and rebuilds the dist for it. A fork's pull request leaves
 * both alone (the CI gates let it, tools/ci/github-range.ts `forkOfPull`), so the commits that land are the
 * contributor's own, authorship and sign-off kept by the rebase merge.
 *
 * The merge goes ahead only on the lead's approval of the reviewing task naming the pull request's head, so a commit
 * pushed after the approval stops it; a head that changes a guarded path also needs a security pass named in that
 * approval (approval.ts `pullClearance`). The head must contain main's tip, since a rebase merge of a stale head lands
 * a tree no check ran on; its author rebases it (or a maintainer, when the pull request lets maintainers edit). Then
 * the head is proven by the repo's gate and rebase-merged pinned to it, as `ship.ts merge` does (merge.ts).
 *
 * The release is cut from main's new tip in the repo dir, holds only the regenerated paths (checked before its push),
 * and merges on a gate that clears only its own head. When main moves past it, a new release is cut from the new tip.
 */

/** The paths whose change needs a security review (CONTRIBUTING.md, "Pull requests"), CI and the ship tools among them. */
export const GUARDED_PATHS: readonly string[] = [
  '.githooks/',
  '.github/',
  'tools/scrub/',
  'tools/ci/',
  'tools/ship/',
  'src/hooks/',
  'src/push-guard/',
  'src/secret-guard/',
  'src/package-guard/',
  'src/permissions/',
];

/** The paths of `changed` that need a security review. */
export const guardedOf = (changed: readonly string[]): string[] => changed.filter((path) => GUARDED_PATHS.some((guarded) => path.startsWith(guarded)));

export interface MergePrArgs {
  dir: string;
  /** The pull request's number. */
  pull: number;
  /** The head sha the lead approved. */
  approved: string;
  /** The caller's task that reviews the pull request, which holds the approval. */
  task: string;
  /** How the release raises the version. */
  raise: BumpKind;
  timeoutMin: number;
  intervalS: number;
}

export const MERGE_PR_USAGE = 'usage: ship.ts merge-pr <repo dir> <pull request number> --approved <sha> --task T<id> [--raise patch|minor|major] [--timeout-min <n>] [--interval-s <n>]';

const BUMP_KINDS: readonly BumpKind[] = ['major', 'minor', 'patch'];
const isBumpKind = (value: string): value is BumpKind => BUMP_KINDS.some((kind) => kind === value);

export function parseMergePrArgs(argv: readonly string[]): MergePrArgs {
  const [dir, pull, ...rest] = argv;
  if (dir === undefined || dir.startsWith('--') || pull === undefined || !/^[1-9]\d*$/.test(pull)) throw new Error(MERGE_PR_USAGE);
  let approved: string | null = null;
  let task: string | null = null;
  let raise: BumpKind = 'patch';
  let timeoutMin = 45;
  let intervalS = 30;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (value === undefined) throw new Error(`${flag ?? ''} needs a value`);
    if (flag === '--approved' && APPROVED_SHA.test(value)) approved = value;
    else if (flag === '--task' && /^T\d+$/.test(value)) task = value;
    else if (flag === '--raise' && isBumpKind(value)) raise = value;
    else if (flag === '--timeout-min' && /^\d+$/.test(value) && Number(value) > 0) timeoutMin = Number(value);
    else if (flag === '--interval-s' && /^\d+$/.test(value) && Number(value) > 0) intervalS = Number(value);
    else throw new Error(`${MERGE_PR_USAGE} (got ${flag} ${value})`);
  }
  if (approved === null || task === null) throw new Error(`${MERGE_PR_USAGE} (--approved and --task are required)`);
  return { dir, pull: Number(pull), approved, task, raise, timeoutMin, intervalS };
}

/** A pull request as merge-pr reads it by its number. */
export interface ContributorPull extends PullRequest {
  title: string;
  state: string;
  merged: boolean;
  /** The repository its head lives in; null when GitHub no longer has it (a deleted fork). */
  headRepo: string | null;
  /** Whether its author lets maintainers push to its head. */
  maintainerCanModify: boolean;
}

export function readContributorPull(gh: Gh, repo: string, pull: number): ContributorPull {
  const what = `pull request #${pull}`;
  const item = recordOf(gh(['api', `repos/${repo}/pulls/${pull}`]), what);
  const headRepo = recordAt(item, 'head', what)['repo'];
  return {
    ...parsePull(item),
    title: stringAt(item, 'title', what),
    state: stringAt(item, 'state', what),
    merged: booleanAt(item, 'merged', what),
    headRepo: isRecord(headRepo) ? stringAt(headRepo, 'full_name', `${what} head repository`) : null,
    maintainerCanModify: booleanAt(item, 'maintainer_can_modify', what),
  };
}

export interface MergePrDeps extends MergeDeps {
  /** Whether the caller may merge the pull request's head on the approval of its task (approval.ts). */
  clearPull: ClearPull;
  /** The repo dir's files and build, for the release. */
  files: RepoFiles;
}

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

/** What the release raises: the version, when the pull request changed what installs receive and raised none. */
export interface Release {
  readonly raise: BumpKind | null;
}

/** The release of the change `base...sha`, read before the merge from the pull request's own commits. */
export function releaseOf(git: MergeDeps['git'], regeneration: Regeneration, base: string, sha: string, changed: readonly string[], kind: BumpKind): Release {
  const shipped = changed.some((path) => regeneration.shipped.some((folder) => path.startsWith(folder)));
  const [first] = regeneration.versionFiles;
  if (!shipped || first === undefined) return { raise: null };
  const from = git('merge-base', base, sha);
  const raised = compareVersions(versionIn(git('show', `${sha}:${first.path}`), first), versionIn(git('show', `${from}:${first.path}`), first)) > 0;
  return { raise: raised ? null : kind };
}

/** The plan regenerate.ts makes the release by on `tip`: the raise when there is one, and always the dist. */
export function releasePlan(git: MergeDeps['git'], regeneration: Regeneration, release: Release, pull: number, tip: string): ReplayPlan {
  const [first] = regeneration.versionFiles;
  if (release.raise === null || first === undefined) return { work: [], raise: null, rebuild: true };
  const set = bumped(versionIn(git('show', `${tip}:${first.path}`), first), release.raise);
  const message = `plugin: version ${formatVersion(set)}, the release of #${pull}\n\nThe pull request #${pull} merged as its author wrote it; this raises the version so installs receive it.\n\n${TRAILER}`;
  return { work: [], raise: { kind: release.raise, set, message }, rebuild: true };
}

/** A branch name free here and on origin: `stem` itself, else the first `<stem>-N`. */
function branchFor(git: MergeDeps['git'], stem: string): string {
  return git('branch', '--list', stem) === '' && git('ls-remote', '--heads', 'origin', `refs/heads/${stem}`) === '' ? stem : freeBranch(git, stem);
}

/**
 * Cuts the release of `pull` from main's tip as a new branch in the repo dir, pushes it and merges it on a gate that
 * clears only that head; main moving past it cuts a new one, MERGE_ATTEMPTS in all. The exit code.
 */
export async function releaseAfter(args: MergePrArgs, deps: MergePrDeps, profile: RepoProfile, regeneration: Regeneration, release: Release): Promise<number> {
  const { git } = deps;
  const listed = listedPaths(regeneration);
  for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
    const tip = mainBranchOf(git, profile.main).tip();
    const branch = branchFor(git, `${args.task.toLowerCase()}-release-pr${args.pull}`);
    git('switch', '--quiet', '--create', branch, tip);
    deps.out(`release of #${args.pull} on ${branch} from ${profile.main} ${tip.slice(0, 7)}: ${regenerate({ git, log: deps.out, ...deps.files }, regeneration, releasePlan(git, regeneration, release, args.pull, tip), tip)}`);
    const changed = lines(git('diff', '--name-only', '--no-renames', tip, 'HEAD'));
    if (changed.length === 0) {
      git('switch', '--quiet', '--detach', tip);
      git('branch', '--quiet', '--delete', branch);
      deps.out(`RELEASED nothing: #${args.pull} leaves the version and the dist as they are`);
      return 0;
    }
    const stray = changed.filter((path) => !isRegenerated(path, listed));
    if (stray.length > 0) {
      deps.err(`REFUSED the release ${branch} changes ${stray.join(', ')}, beyond the version and the dist: nothing was pushed`);
      return 1;
    }
    pushOwnBranch(git, profile.main);
    const sha = git('rev-parse', 'HEAD');
    const exit = await mergeRun({ dir: args.dir, head: branch, timeoutMin: args.timeoutMin, intervalS: args.intervalS, noteFile: null, approved: null }, deps, async (head, at) =>
      head === branch && at === sha ? null : `${head} ${at.slice(0, 9)} is not the release ${branch} ${sha.slice(0, 9)} this merge cut`,
    );
    if (exit.kind === 'done') return exit.code;
    deps.out(`the release ${branch} fell behind: ${exit.reason}; cutting it again`);
  }
  deps.err(`REFUSED main moved past ${MERGE_ATTEMPTS} releases of #${args.pull}: run merge-pr's release again once main is quiet`);
  return 1;
}

const refusedWith = (deps: MergePrDeps, reason: string): number => {
  deps.err(`REFUSED ${reason}`);
  return 1;
};

/** Why `pull` cannot merge onto `tip`, which its head lacks: who rebases it (T3021 edge case 11). */
function behindReason(pull: ContributorPull, main: string, tip: string): string {
  const who = pull.maintainerCanModify ? 'its author, or a maintainer since it lets maintainers edit it,' : 'its author';
  return `#${pull.number} ${pull.headSha.slice(0, 7)} does not contain ${main} ${tip.slice(0, 7)}: ${who} rebases it onto ${main}, then the lead approves the new head`;
}

/** The merge of the pull request, then its release; prints every outcome. */
export async function runMergePr(args: MergePrArgs, deps: MergePrDeps): Promise<number> {
  const { git } = deps;
  const repo = slugOf(git('remote', 'get-url', 'origin'));
  const profile = profileFor(deps.profiles, repo);
  const regeneration = regenerationFor(profile.regenerated);
  if (regeneration !== null && git('status', '--porcelain') !== '') {
    return refusedWith(deps, `${args.dir} has uncommitted changes, and the release is cut there: run merge-pr from a clean worktree`);
  }
  const main: MainBranch = mainBranchOf(git, profile.main);
  const tip = main.tip();
  git('fetch', '--quiet', 'origin', `refs/pull/${args.pull}/head`);
  const sha = git('rev-parse', 'FETCH_HEAD');
  if (!sha.startsWith(args.approved)) {
    return refusedWith(deps, `#${args.pull}'s head is ${sha.slice(0, 9)}, not the approved ${args.approved}: a commit pushed after the approval needs the lead's approval of the new head`);
  }
  const changed = lines(git('diff', '--name-only', '--no-renames', `${tip}...${sha}`));
  const clearance = await deps.clearPull(args.task, sha, args.approved, guardedOf(changed));
  if (clearance.kind === 'refused') return refusedWith(deps, clearance.reason);
  deps.out(`merge of #${args.pull} ${sha.slice(0, 9)}: ${clearance.kind === 'self' ? "the caller's own, a root team's lead" : `approved by ${clearance.by}`}`);
  const callers = deps.renamedCallers(`refs/remotes/origin/${profile.main}`, sha, repo);
  if (callers !== null) return refusedWith(deps, callers);

  const credential = deps.credential();
  if (credential.kind !== 'found') {
    deps.err(describeCredential(credential));
    return 1;
  }
  const gh = deps.ghFor(credential.secret);
  const pull = readContributorPull(gh, repo, args.pull);
  if (pull.state !== 'open') return refusedWith(deps, `#${args.pull} is ${pull.merged ? 'merged' : pull.state} already`);
  if (pull.baseRef !== profile.main) return refusedWith(deps, `#${args.pull} goes into ${pull.baseRef}, not ${profile.main}`);
  if (pull.headSha !== sha) return refusedWith(deps, `#${args.pull}'s head moved to ${pull.headSha.slice(0, 9)} while it was read: the lead approves the new head`);
  if (!main.contains(sha, tip)) return refusedWith(deps, behindReason(pull, profile.main, tip));
  const release = regeneration === null ? null : releaseOf(git, regeneration, tip, sha, changed, args.raise);

  deps.out(`#${args.pull} ${pull.url} from ${pull.headRepo ?? 'a deleted fork'}: ${pull.title}`);
  const result = await mergeProvenPull(
    { repo, head: `#${args.pull}`, base: profile.main, sha, title: pull.title, body: '' },
    gh,
    main,
    proofFor(profile, gh, repo, pull.headRef, args, deps),
    pull,
    deps.out,
  );
  if (result.kind === 'moved') return refusedWith(deps, behindReason(pull, profile.main, result.tip));
  if (result.kind === 'refused') return refusedWith(deps, result.reason);
  deps.out(`MERGED #${args.pull} into ${profile.main}, now at ${result.sha.slice(0, 7)}`);
  if (result.kind === 'drifted') deps.err(`DRIFTED ${result.reason}`);
  // A drifted merge landed too, so its release goes ahead.
  const released = regeneration === null || release === null ? 0 : await releaseAfter(args, deps, profile, regeneration, release);
  return result.kind === 'drifted' ? 1 : released;
}

/** The real deps of `ship.ts merge`, with the pull request's clearance and the repo dir's files. */
export function realMergePrDeps(dir: string): MergePrDeps {
  return {
    ...realMergeDeps(dir),
    clearPull: clearPullFrom(process.env, { env: process.env, userHome: homedir(), files: nodeFiles(realSleep), clock: systemClock }),
    files: realRepoFiles(dir),
  };
}

/** `ship.ts merge-pr ...`: the exit code; a usage or git error is one line, never a stack. */
export async function mergePrCommand(argv: readonly string[], depsFor: (dir: string) => MergePrDeps = realMergePrDeps): Promise<number> {
  let err: (line: string) => void = (line) => console.error(line);
  try {
    const args = parseMergePrArgs(argv);
    const deps = depsFor(args.dir);
    err = deps.err;
    return await runMergePr(args, deps);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

