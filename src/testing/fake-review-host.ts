import type { HostEnd, HostReach, HostUse, IssueTarget } from '../issues/host.ts';
import type { HostPaths, HostPull, HostViewer, PullFacts, PullReviewHost, ReviewDraft } from '../issues/review.ts';

/** The head every pull request of the fake has unless a test gave it another. */
export const FAKE_HEAD = 'c'.repeat(40);

/**
 * A pull request review host holding the pull requests a test gave it (any other is missing), each changing the
 * paths given with it. Its access acts as `reviewer`, reached as `<owner>: writes as the test` unless a test made it
 * unreachable; each posted review is recorded, and ends done unless a test set it to fail.
 */
export class FakeReviewHost implements PullReviewHost {
  readonly reviews: ReviewDraft[] = [];
  /** The pull requests whose changed paths were read, in order. */
  readonly pathReads: string[] = [];
  private readonly pulls = new Map<string, { readonly pull: PullFacts; readonly paths: readonly string[] }>();
  private unreachableFor: string | undefined;
  private login = 'reviewer';
  private pullFailure: string | undefined;
  private pathsFailure: string | undefined;
  private viewerFailure: string | undefined;
  private reviewEnd: HostEnd = { kind: 'done' };

  /** From now on, `target` is a pull request with these facts (open, by `author`, at FAKE_HEAD unless given) changing `paths`. */
  holds(target: IssueTarget, pull: Partial<PullFacts> = {}, paths: readonly string[] = []): this {
    this.pulls.set(keyOf(target), { pull: { state: 'open', author: 'author', head: FAKE_HEAD, ...pull }, paths });
    return this;
  }

  /** From now on, the access acts as `login`. */
  actsAs(login: string): this {
    this.login = login;
    return this;
  }

  /** From now on, the host cannot be reached, for `reason`. */
  unreachable(reason: string): this {
    this.unreachableFor = reason;
    return this;
  }

  /** From now on, a read of a pull request fails for `reason`. */
  failsPull(reason: string): this {
    this.pullFailure = reason;
    return this;
  }

  /** From now on, a read of a pull request's changed paths fails for `reason`. */
  failsPaths(reason: string): this {
    this.pathsFailure = reason;
    return this;
  }

  /** From now on, a read of the access's account fails for `reason`. */
  failsViewer(reason: string): this {
    this.viewerFailure = reason;
    return this;
  }

  /** From now on, posting a review fails for `reason`. */
  failsReview(reason: string): this {
    this.reviewEnd = { kind: 'failed', reason };
    return this;
  }

  reach(repo: string, _use: HostUse): Promise<HostReach> {
    const owner = repo.split('/')[0] ?? repo;
    return Promise.resolve(this.unreachableFor === undefined ? { kind: 'reached', access: `${owner}: writes as the test`, scope: owner } : { kind: 'unreachable', reason: this.unreachableFor });
  }

  pull(target: IssueTarget): Promise<HostPull> {
    if (this.pullFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.pullFailure });
    }
    const held = this.pulls.get(keyOf(target));
    return Promise.resolve(held === undefined ? { kind: 'missing' } : { kind: 'found', pull: held.pull });
  }

  changedPaths(target: IssueTarget): Promise<HostPaths> {
    this.pathReads.push(keyOf(target));
    if (this.pathsFailure !== undefined) {
      return Promise.resolve({ kind: 'failed', reason: this.pathsFailure });
    }
    return Promise.resolve({ kind: 'read', paths: this.pulls.get(keyOf(target))?.paths ?? [] });
  }

  viewer(_repo: string): Promise<HostViewer> {
    return Promise.resolve(this.viewerFailure === undefined ? { kind: 'read', login: this.login } : { kind: 'failed', reason: this.viewerFailure });
  }

  review(draft: ReviewDraft): Promise<HostEnd> {
    this.reviews.push(draft);
    return Promise.resolve(this.reviewEnd);
  }
}

function keyOf(target: IssueTarget): string {
  return `${target.repo}#${target.number}`;
}
