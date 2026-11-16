import { targetText, type HostEnd, type HostReach, type HostUse, type IssueTarget } from './host.ts';
import type { PullState } from './pull.ts';
import type { ReviewPath } from '../config/types.ts';
import { reviewHits } from '../push-guard/review-paths.ts';

/** A review's verdict: it approves the pull request, or asks for changes before it may land. */
export type ReviewVerdict = 'approve' | 'request-changes';

/** One review to post: its verdict, the head commit its reviewer read (a full id), and its text when it has one. */
export interface ReviewDraft {
  readonly target: IssueTarget;
  readonly verdict: ReviewVerdict;
  readonly head: string;
  readonly body?: string;
}

/** What a review's checks need of a pull request: its state, who opened it, and its head commit's full id. */
export interface PullFacts {
  readonly state: PullState;
  readonly author: string;
  readonly head: string;
}

export type HostPullFacts = { readonly kind: 'found'; readonly pull: PullFacts } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** Every path a pull request changes, a renamed file's old path too, or why they could not be read in full. */
export type HostPaths = { readonly kind: 'read'; readonly paths: readonly string[] } | { readonly kind: 'failed'; readonly reason: string };

/** The account the host's access acts as, or why it could not be read. */
export type HostViewer = { readonly kind: 'read'; readonly login: string } | { readonly kind: 'failed'; readonly reason: string };

/** A host a pull request review is posted to: GitHub (github/pull-review.ts), or a test's fake. */
export interface PullReviewHost {
  reach(repo: string, use: HostUse): Promise<HostReach>;
  pull(target: IssueTarget): Promise<HostPullFacts>;
  changedPaths(target: IssueTarget): Promise<HostPaths>;
  viewer(repo: string): Promise<HostViewer>;
  review(draft: ReviewDraft): Promise<HostEnd>;
}

/**
 * A security pass a caller named: the done task as a line shows it (`T9 (done by security)`), and the text its done
 * change recorded (note and evidence), which must name the head it passed.
 */
export interface SecurityPass {
  readonly shown: string;
  readonly record: string;
}

/**
 * What an approval must clear: the merge review gate's entries (teamrig's generic ones and `pushGuard.reviewPaths`,
 * push-guard/review-paths.ts), so GitHub's approval holds the same paths a merge does, and the security pass when
 * one is named: the done task the caller checked.
 */
export interface ReviewGate {
  readonly entries: readonly ReviewPath[];
  readonly verdict?: SecurityPass;
}

/**
 * Whether `record` passes `head` (a full lowercase commit id): it says `PASS at <head>` or `PASS at head <head>`, in
 * any case, the head a word of its own. A done security task is done whatever it found, so a record naming the head
 * otherwise (`CHANGES at <head>`, `old head <head> superseded`), a pass of another head or of another change
 * altogether, passes nothing: the merge review gate also binds its pass to one base..head.
 */
export function passesHead(record: string, head: string): boolean {
  return new RegExp(`(?<![a-z0-9])pass\\s+at\\s+(?:head\\s+)?${head}(?![0-9a-f])`, 'u').test(record.toLowerCase());
}

/**
 * The changed paths a security entry covers, each once, in their order. A `check` entry counts too, as no review
 * check runs before a GitHub approval; a leader entry does not, as the merge gate still holds it for the leader.
 */
export function gatedPathsIn(paths: readonly string[], entries: readonly ReviewPath[]): string[] {
  const security = entries.filter((entry) => entry.class === 'security');
  return [...new Set(reviewHits(paths, security).map((hit) => hit.path))];
}

/** The gated paths a refusal names at most, so a large change stays one line. */
const SHOWN_PATHS = 3;

/** The verdict as a line says it. */
const DONE_WORD: Readonly<Record<ReviewVerdict, string>> = { approve: 'approved', 'request-changes': 'changes requested' };

/**
 * Posts one review through `host`, one line said for each step: ACCESS, then REVIEWED, or FAILED with the reason and
 * nothing posted. Before the post it reads the pull request: it must be open, its head still the commit the reviewer
 * read (GitHub keeps a review bound to an older commit without a word, so a push after the read is caught here),
 * not opened by the access's own account, and an approval of a change to a security path of the merge review gate must name the security pass.
 * A review is a reviewer's word on GitHub only: it approves no task's wait and merges nothing. True when posted.
 */
export async function reviewPull(host: PullReviewHost, draft: ReviewDraft, gate: ReviewGate, say: (line: string) => void): Promise<boolean> {
  const shown = targetText(draft.target);
  const refused = (reason: string): false => {
    say(`FAILED ${shown}: ${reason}; no review was posted`);
    return false;
  };
  const reach = await host.reach(draft.target.repo, 'write');
  if (reach.kind === 'unreachable') {
    return refused(reach.reason);
  }
  say(`ACCESS ${reach.access}`);
  const read = await host.pull(draft.target);
  if (read.kind === 'failed') {
    return refused(read.reason);
  }
  if (read.kind === 'missing') {
    return refused(`${shown} is no pull request the access can see`);
  }
  const { pull } = read;
  if (pull.state !== 'open') {
    return refused(`it is ${pull.state}: a review goes only on an open pull request`);
  }
  if (pull.head !== draft.head) {
    return refused(`its head is now ${pull.head.slice(0, 9)}, not the ${draft.head.slice(0, 9)} you read: read the new commits, then review that head`);
  }
  const viewer = await host.viewer(draft.target.repo);
  if (viewer.kind === 'failed') {
    return refused(viewer.reason);
  }
  if (viewer.login.toLowerCase() === pull.author.toLowerCase()) {
    return refused(`it is ${viewer.login}'s own pull request, the account the access acts as: another reviewer reviews it`);
  }
  const gated = draft.verdict === 'approve' ? await gatedChange(host, draft, gate) : { kind: 'clear' as const };
  if (gated.kind === 'refused') {
    return refused(gated.reason);
  }
  const posted = await host.review(draft);
  if (posted.kind === 'failed') {
    return refused(posted.reason);
  }
  const pass = gated.kind === 'passed' ? `, its gated paths passed by ${gated.verdict}` : '';
  say(`REVIEWED ${shown}: ${DONE_WORD[draft.verdict]} at ${draft.head.slice(0, 9)}${pass}`);
  return true;
}

type GateEnd = { readonly kind: 'clear' } | { readonly kind: 'passed'; readonly verdict: string } | { readonly kind: 'refused'; readonly reason: string };

/**
 * Whether an approval of the pull request clears the gate: it changes no gated path, or the security pass is named
 * and its record names the very head the review is bound to.
 */
async function gatedChange(host: PullReviewHost, draft: ReviewDraft, gate: ReviewGate): Promise<GateEnd> {
  if (!gate.entries.some((entry) => entry.class === 'security')) {
    return { kind: 'clear' };
  }
  const changed = await host.changedPaths(draft.target);
  if (changed.kind === 'failed') {
    return { kind: 'refused', reason: changed.reason };
  }
  const touched = gatedPathsIn(changed.paths, gate.entries);
  if (touched.length === 0) {
    return { kind: 'clear' };
  }
  const more = touched.length > SHOWN_PATHS ? ` and ${touched.length - SHOWN_PATHS} more` : '';
  const what = `it changes ${touched.slice(0, SHOWN_PATHS).join(', ')}${more}, under the review gate's security paths`;
  if (gate.verdict === undefined) {
    return { kind: 'refused', reason: `${what}: approve it only with --verdict naming the security reviewer's done task` };
  }
  if (!passesHead(gate.verdict.record, draft.head)) {
    return {
      kind: 'refused',
      reason: `${what}, and ${gate.verdict.shown} records no pass of its head ${draft.head}: the pass's done note or evidence says PASS at the full head it passed, so pass this head first`,
    };
  }
  return { kind: 'passed', verdict: gate.verdict.shown };
}
