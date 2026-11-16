import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import type { SecretScanner } from '../core/secrets.ts';
import { targetText, type HostEnd, type HostReach, type HostUse, type IssueTarget } from '../issues/host.ts';
import type { PullState } from '../issues/pull.ts';
import type { HostPaths, HostPullFacts, HostViewer, PullReviewHost, ReviewDraft, ReviewVerdict } from '../issues/review.ts';
import { exitText } from '../open/processes.ts';
import { COMMIT_ID, isLogin, PULL_FILES_PAGE, PULL_FILES_PAGES, pullFilesArgs, pullReadArgs, pullReviewArgs, viewerReadArgs, type GhResult, type GhRunner, type ReviewEvent } from './gh.ts';
import { reachWith, writeFailureText } from './host.ts';
import { ghFailureKind, plainLine, startFailureText } from './issues.ts';
import { NoAccessError, type RepoTokens } from './tokens.ts';

/** GitHub's word for each verdict, as its REST API takes it in `event`. */
const GITHUB_EVENT: Readonly<Record<ReviewVerdict, ReviewEvent>> = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' };

/** One REST call's end: what gh printed, Not Found, or the reason it failed. */
type Call = { readonly kind: 'ran'; readonly stdout: string } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * GitHub as a pull request review host (issues/review.ts): each read and the review one gh REST call the runner's
 * allowlist takes (gh.ts), made with the token saved for the repository's owner and never the gh login. gh's own
 * error, any secret shape in it redacted, is the reason a call failed.
 */
export class GitHubPullReviewHost implements PullReviewHost {
  private readonly gh: GhRunner;
  private readonly tokens: RepoTokens;
  private readonly scanner: SecretScanner;

  constructor(gh: GhRunner, tokens: RepoTokens, scanner: SecretScanner) {
    this.gh = gh;
    this.tokens = tokens;
    this.scanner = scanner;
  }

  reach(repo: string, use: HostUse): Promise<HostReach> {
    return reachWith(this.tokens, repo, use);
  }

  async pull(target: IssueTarget): Promise<HostPullFacts> {
    const call = await this.call(target.repo, pullReadArgs(target), 'read', { target, write: false });
    if (call.kind !== 'ran') {
      return call;
    }
    const pull = pullFactsIn(call.stdout);
    return pull === undefined ? { kind: 'failed', reason: `gh printed no pull request for ${targetText(target)}` } : { kind: 'found', pull };
  }

  /**
   * Every path the pull request changes, a renamed file's old path too, so a file moved out of a gated folder still
   * counts: page after page until one is short. GitHub lists at most PULL_FILES_PAGES pages; a change past them
   * cannot be read in full, so it fails rather than judge on part of it.
   */
  async changedPaths(target: IssueTarget): Promise<HostPaths> {
    const paths: string[] = [];
    for (let page = 1; page <= PULL_FILES_PAGES; page += 1) {
      const call = await this.call(target.repo, pullFilesArgs(target, page), 'read the files of', { target, write: false });
      if (call.kind === 'missing') {
        return { kind: 'failed', reason: `${targetText(target)} is no pull request the access can see` };
      }
      if (call.kind === 'failed') {
        return call;
      }
      const files = filesIn(call.stdout);
      if (files === undefined) {
        return { kind: 'failed', reason: `gh printed no page of the files of ${targetText(target)}` };
      }
      paths.push(...files.paths);
      if (files.count < PULL_FILES_PAGE) {
        return { kind: 'read', paths };
      }
    }
    return { kind: 'failed', reason: `${targetText(target)} changes more files than GitHub lists (${PULL_FILES_PAGE * PULL_FILES_PAGES}): its paths cannot all be checked` };
  }

  async viewer(repo: string): Promise<HostViewer> {
    const call = await this.call(repo, viewerReadArgs(), 'read the account of', { write: false });
    if (call.kind === 'missing') {
      return { kind: 'failed', reason: 'GitHub gave no account for the token' };
    }
    if (call.kind === 'failed') {
      return call;
    }
    const login = loginOfUser(call.stdout);
    return login === undefined ? { kind: 'failed', reason: 'gh printed no login for the account the token acts as' } : { kind: 'read', login };
  }

  async review(draft: ReviewDraft): Promise<HostEnd> {
    const body = draft.body === undefined ? {} : { body: draft.body };
    const call = await this.call(draft.target.repo, pullReviewArgs(draft.target, { event: GITHUB_EVENT[draft.verdict], commit: draft.head, ...body }), 'review', { target: draft.target, write: true });
    return call.kind === 'ran' ? { kind: 'done' } : { kind: 'failed', reason: call.kind === 'failed' ? call.reason : `${targetText(draft.target)} is no pull request the access can see` };
  }

  /**
   * Runs one call with the owner's token. A read GitHub answers Not Found is missing; any other failure is worded for
   * the pull request it was on (`on`), or for the repository's token when it was on none. A stopped write may have
   * posted, so its reason says to look before a rerun.
   */
  private async call(repo: string, args: readonly string[], what: string, on: { readonly target?: IssueTarget; readonly write: boolean }): Promise<Call> {
    const access = await this.tokens.accessFor(repo);
    if (access instanceof NoAccessError) {
      return { kind: 'failed', reason: access.message };
    }
    const shown = on.target === undefined ? `the token for ${repo}` : targetText(on.target);
    let result: GhResult;
    try {
      result = await this.gh.run({ args, env: access.env });
    } catch (error) {
      return { kind: 'failed', reason: startFailureText(error) };
    }
    if (result.end.kind === 'signal') {
      const look = on.write ? ': look on GitHub before a rerun' : '';
      return { kind: 'failed', reason: `gh was stopped (${result.end.signal}) on its way to ${what} ${shown}${look}` };
    }
    if (result.end.code === 0) {
      return { kind: 'ran', stdout: result.stdout };
    }
    if (!on.write && ghFailureKind(result.end.code, result.stderr) === 'not-visible') {
      return { kind: 'missing' };
    }
    const reason = on.target === undefined ? plainLine(`gh api to ${what} ${shown} ${exitText(result.end.code, result.stderr)}`) : writeFailureText(on.target, what, result.end.code, result.stderr, access);
    return { kind: 'failed', reason: this.scanner.redact(reason) };
  }
}

function parsed(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** A pull request's state as its REST read gives it: closed and merged apart, as `state` says closed for both. */
function stateOf(pull: JsonRecord): PullState | undefined {
  const state = stringField(pull, 'state');
  if (state === 'open') {
    return 'open';
  }
  if (state !== 'closed') {
    return undefined;
  }
  return pull['merged'] === true || stringField(pull, 'merged_at') !== undefined ? 'merged' : 'closed';
}

/** The state, author and head commit of a pull request as `gh api repos/<o>/<n>/pulls/<n>` prints it; undefined when a field is missing or malformed. */
export function pullFactsIn(stdout: string): { readonly state: PullState; readonly author: string; readonly head: string } | undefined {
  const pull = parsed(stdout);
  if (!isRecord(pull)) {
    return undefined;
  }
  const state = stateOf(pull);
  const user = recordField(pull, 'user');
  const author = user === undefined ? undefined : stringField(user, 'login');
  const headRecord = recordField(pull, 'head');
  const head = headRecord === undefined ? undefined : stringField(headRecord, 'sha');
  if (state === undefined || author === undefined || !isLogin(author.replace(/\[bot\]$/u, '')) || head === undefined || !COMMIT_ID.test(head)) {
    return undefined;
  }
  return { state, author, head };
}

/** One page of changed files: each file's path and a renamed one's old path, and how many files the page held. */
export function filesIn(stdout: string): { readonly paths: readonly string[]; readonly count: number } | undefined {
  const page = parsed(stdout);
  if (!Array.isArray(page)) {
    return undefined;
  }
  const paths: string[] = [];
  for (const file of page) {
    const name = isRecord(file) ? stringField(file, 'filename') : undefined;
    if (!isRecord(file) || name === undefined) {
      return undefined;
    }
    paths.push(name);
    const before = stringField(file, 'previous_filename');
    if (before !== undefined && before !== name) {
      paths.push(before);
    }
  }
  return { paths, count: page.length };
}

/** The login of the account `gh api user` prints, when it has a login's shape. */
function loginOfUser(stdout: string): string | undefined {
  const user = parsed(stdout);
  const login = isRecord(user) ? stringField(user, 'login') : undefined;
  return login !== undefined && isLogin(login) ? login : undefined;
}
