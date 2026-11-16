import { ownDiff } from './catch-up.ts';
import { isRegenerated } from './leftovers.ts';
import { type RegenerateDeps, type Regeneration, type ReplayPlan, listedPaths, regenerate, workPathspec } from './regenerate.ts';
import { TRAILER } from './ship-commits.ts';
import { type BumpKind, bumped, formatVersion, versionIn } from './version-bump.ts';

/**
 * A contributor's pull request landed without its version raise and dist (T3341): those files move with every merge
 * to main, so a pull request that carries them conflicts as soon as main moves, and its author would have to push
 * again for each release. Its work is replayed on main's tip instead, commit by commit with its author, message and
 * sign-off kept, its changes to the version files and the dist dropped (in commits of their own or mixed with work);
 * then the version is raised above main's and the dist rebuilt, as a release does (regenerate.ts).
 *
 * What lands is what the lead approved: the replayed work diff must equal the approved head's work diff, context
 * lines included (catch-up.ts `ownDiff`), else the replay is refused and its author rebases it.
 */

export interface PullReplay {
  readonly pull: number;
  /** The approved head of the pull request. */
  readonly sha: string;
  /** main's tip, checked out in the repo dir as the new branch the work is replayed on. */
  readonly tip: string;
  /** How the version is raised when the work reaches installs. */
  readonly raise: BumpKind;
}

/** What a cut made on its branch, for the log; or why it holds nothing to merge, or may not. */
export type Cut = { readonly kind: 'cut'; readonly done: string } | { readonly kind: 'nothing'; readonly line: string } | { readonly kind: 'refused'; readonly reason: string };

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');

type Picked = 'picked' | 'empty' | { readonly refused: string };

/** One commit of the pull request applied on the checked-out branch without the regenerated paths, committed as its author wrote it. */
function pickWork(deps: RegenerateDeps, listed: readonly string[], commit: string, tip: string): Picked {
  const { git } = deps;
  try {
    git('cherry-pick', '--no-commit', commit);
  } catch {
    const unmerged = lines(git('diff', '--name-only', '--diff-filter=U'));
    // A conflict in the version files or the dist alone is dropped below with the rest of them.
    if (unmerged.length === 0 || unmerged.some((path) => !isRegenerated(path, listed))) {
      // A --no-commit pick leaves no cherry-pick to abort: this puts the index and the files back as HEAD has them.
      git('reset', '--quiet', '--merge');
      return { refused: `replaying its commit ${commit.slice(0, 9)} on main ${tip.slice(0, 7)} conflicts in its work (${unmerged.filter((path) => !isRegenerated(path, listed)).join(', ') || 'no file named'}): its author rebases it onto main, then the lead approves the new head` };
    }
  }
  git('restore', '--source=HEAD', '--staged', '--worktree', '--', ...listed);
  if (git('diff', '--cached', '--name-only') === '') {
    // Only the version files or the dist: nothing of it lands.
    git('reset', '--quiet');
    return 'empty';
  }
  try {
    git('commit', '--quiet', '--reuse-message', commit);
  } catch (error) {
    return { refused: `committing its commit ${commit.slice(0, 9)} again failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return 'picked';
}

/**
 * The plan regenerate.ts makes a contributor's release by on `tip`: the raise when there is one, its commit message
 * from `messageFor` with the version it sets, and always the dist.
 */
export function releaseFrom(git: RegenerateDeps['git'], regeneration: Regeneration, raise: BumpKind | null, tip: string, messageFor: (version: string) => string): ReplayPlan {
  const [first] = regeneration.versionFiles;
  if (raise === null || first === undefined) return { work: [], raise: null, rebuild: true };
  const set = bumped(versionIn(git('show', `${tip}:${first.path}`), first), raise);
  return { work: [], raise: { kind: raise, set, message: messageFor(formatVersion(set)) }, rebuild: true };
}

/** The plan for the replayed work of `pull` on `tip`. */
export const replayPlan = (git: RegenerateDeps['git'], regeneration: Regeneration, raise: BumpKind | null, pull: number, tip: string): ReplayPlan =>
  releaseFrom(
    git,
    regeneration,
    raise,
    tip,
    (version) => `plugin: version ${version}, the work of #${pull}\n\nThe work of pull request #${pull} landed without its own version raise and dist; this raises the version so installs receive it.\n\n${TRAILER}`,
  );

/**
 * Replays the work of `at.sha` on the checked-out branch made at `at.tip`, then the raise and the dist. Leaves the
 * branch as it got when it refuses; the caller drops it.
 */
export function replayPull(deps: RegenerateDeps, regeneration: Regeneration, at: PullReplay): Cut {
  const { git } = deps;
  const listed = listedPaths(regeneration);
  const pathspec = workPathspec(regeneration);
  const base = git('merge-base', at.tip, at.sha);
  const own = ownDiff(git, base, at.sha, pathspec);
  if (own === '') return { kind: 'nothing', line: `LANDED nothing: #${at.pull} changes only the version files and the dist, which the release makes` };
  // A merge commit's own changes are its parents' work, replayed through them; the diff check below holds the rest.
  for (const commit of lines(git('log', '--reverse', '--no-merges', '--format=%H', `${at.tip}..${at.sha}`))) {
    const picked = pickWork(deps, listed, commit, at.tip);
    if (typeof picked !== 'string') return { kind: 'refused', reason: picked.refused };
  }
  if (ownDiff(git, at.tip, git('rev-parse', 'HEAD'), pathspec) !== own) {
    return { kind: 'refused', reason: `the work of #${at.pull} changes when replayed on main ${at.tip.slice(0, 7)}: its author rebases it onto main, then the lead approves the new head` };
  }
  const changed = lines(git('diff', '--name-only', '--no-renames', at.tip, 'HEAD'));
  const shipped = changed.some((path) => regeneration.shipped.some((folder) => path.startsWith(folder)));
  try {
    return { kind: 'cut', done: `replayed its work without its version and dist, ${regenerate(deps, regeneration, replayPlan(git, regeneration, shipped ? at.raise : null, at.pull, at.tip), at.tip)}` };
  } catch (error) {
    return { kind: 'refused', reason: `making the version raise or the dist for #${at.pull} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
