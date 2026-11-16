/**
 * GH-DRIFT (T3205): a GitHub thread whose labels disagree with what is happening on it, so a contributor reading the
 * issue is misled (issue #922: a pull request was open on it while it still showed `status:open`). Pure: the writing
 * sync finds the drift in the issues and pull requests it read and keeps it in its own state file under the sync's
 * lock (src/cli/commands/issue-drift.ts), and `check` shows each row to the lead with no GitHub call
 * (src/cli/github-drift-check.ts).
 */

import { isRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { HostIssue } from '../issues/issue.ts';
import type { HostPull } from '../issues/pull.ts';
import { STATUS_LABEL_PREFIX, STATUS_LABELS } from '../issues/status-push.ts';
import { issueRef } from './map.ts';
import { isInsideAuthor, isOurAuthor, type OurLogins } from './trust.ts';

/** The kinds of drift found on an issue: `linked-pull`, an open one an open pull request closes that does not show `status:in review`. */
export const ISSUE_DRIFT_KINDS = ['linked-pull'] as const;

/** The kinds of drift found on a pull request: `pull-unlabelled`, an open outside one no one labelled. */
export const PULL_DRIFT_KINDS = ['pull-unlabelled'] as const;

export type IssueDriftKind = (typeof ISSUE_DRIFT_KINDS)[number];
export type PullDriftKind = (typeof PULL_DRIFT_KINDS)[number];
export type DriftKind = IssueDriftKind | PullDriftKind;

/** An issue out of step, as the last read of its repository saw it. */
export interface IssueDrift {
  /** `owner/name`. */
  readonly repo: string;
  /** As the task list names it (github/map.ts issueRef). */
  readonly ref: string;
  readonly kind: IssueDriftKind;
  /** The `status:` labels it showed, in the host's order; empty for none. */
  readonly shown: readonly string[];
  /** Whether anyone was assigned to it. */
  readonly assigned: boolean;
}

/** A pull request out of step, as the last read of its repository's pull requests saw it. */
export interface PullDrift {
  readonly repo: string;
  /** Named as an issue is: a pull request shares its repository's numbers. */
  readonly ref: string;
  readonly kind: PullDriftKind;
}

export type Drift = IssueDrift | PullDrift;

/** The repositories a sync read: their issues, and their pull requests, each read on its own and able to fail alone. */
export interface DriftRead {
  readonly issues: ReadonlySet<string>;
  readonly pulls: ReadonlySet<string>;
}

/** The drift on one issue as read: none on a closed one. GitHub matches label names without case, so this does too. */
export function issueDrift(issue: HostIssue): IssueDrift[] {
  if (issue.state !== 'open' || issue.linkedPulls === 0) {
    return [];
  }
  const shown = issue.labels.filter((label) => label.toLowerCase().startsWith(STATUS_LABEL_PREFIX));
  if (shown.some((label) => label.toLowerCase() === STATUS_LABELS.verifying)) {
    return [];
  }
  return [{ repo: issue.repo, ref: issueRef(issue.repo, issue.number), kind: 'linked-pull', shown, assigned: issue.assignees.length > 0 }];
}

/** The account kind of a person; a pull request an app opens (`Bot`: a dependency update) is labelled by the app. */
const PERSON = 'User';

/**
 * The drift on one pull request as read: an open one by a person outside the repository and the team (`ours`) with
 * no label, so no maintainer took it in. A draft counts too: it waits on the same intake.
 */
export function pullDrift(pull: HostPull, ours: OurLogins): PullDrift[] {
  const inside = isInsideAuthor(pull.authorAssociation) || isOurAuthor(pull.authorAssociation, pull.author, ours);
  if (pull.state !== 'open' || pull.authorKind !== PERSON || inside || pull.labelCount > 0) {
    return [];
  }
  return [{ repo: pull.repo, ref: issueRef(pull.repo, pull.number), kind: 'pull-unlabelled' }];
}

/** Whether a sync read the source a row of this kind comes from in its repository. */
function wasRead(read: DriftRead, drift: Drift): boolean {
  return (isPullDrift(drift) ? read.pulls : read.issues).has(drift.repo);
}

/**
 * The drift after a sync: each repository read gives what it found now, so a thread set right drops out; a source not
 * read this time (its read failed) keeps its rows as they were.
 */
export function stepDrift(before: readonly Drift[], read: DriftRead, found: readonly Drift[]): Drift[] {
  return [...before.filter((drift) => !wasRead(read, drift)), ...found.filter((drift) => wasRead(read, drift))];
}

/** What names a row while it stands, so the lead is told of it once. */
export function driftKey(drift: Pick<Drift, 'ref' | 'kind'>): string {
  return `gh-drift ${drift.ref} ${drift.kind}`;
}

/** The lead's GH-DRIFT line for a row. */
export function driftText(drift: Drift): string {
  if (isPullDrift(drift)) {
    return `GH-DRIFT ${drift.ref}: an outside pull request no one labelled, so no maintainer took it in: label it as you take it in, or close it saying why`;
  }
  const shows = drift.shown.length === 0 ? 'no status label' : drift.shown.join(', ');
  const assignee = drift.assigned ? '' : ' and no assignee';
  return (
    `GH-DRIFT ${drift.ref}: an open pull request closes it, yet it shows ${shows}${assignee}, not ${STATUS_LABELS.verifying}: ` +
    `have its task's owner set it verifying, or the pull request's author unlink it`
  );
}

function isPullDrift(drift: Drift): drift is PullDrift {
  return isPullDriftKind(drift.kind);
}

/** The format of the drift file this code writes; a file in another format, or damaged, reads as no drift. */
export const DRIFT_STATE_FORMAT = 1;

/** The rows a file holds; a damaged row, or one of a kind this code does not know, is left out; a damaged file reads as none. */
export function parseDrift(text: string): Drift[] {
  const record = parseObject(text.trim());
  const list = record?.[VERSION_FIELD] === DRIFT_STATE_FORMAT ? record['drift'] : undefined;
  return Array.isArray(list) ? list.flatMap(driftOf) : [];
}

function driftOf(value: unknown): Drift[] {
  if (!isRecord(value)) {
    return [];
  }
  const { repo, ref, kind, shown, assigned } = value;
  if (typeof repo !== 'string' || typeof ref !== 'string') {
    return [];
  }
  if (isPullDriftKind(kind)) {
    return [{ repo, ref, kind }];
  }
  if (!isIssueDriftKind(kind) || !isTextList(shown) || typeof assigned !== 'boolean') {
    return [];
  }
  return [{ repo, ref, kind, shown, assigned }];
}

function isIssueDriftKind(value: unknown): value is IssueDriftKind {
  return ISSUE_DRIFT_KINDS.some((kind) => kind === value);
}

function isPullDriftKind(value: unknown): value is PullDriftKind {
  return PULL_DRIFT_KINDS.some((kind) => kind === value);
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A row with only its kind's fields, so the file holds nothing else. */
function rowOf(drift: Drift): Drift {
  if (isPullDrift(drift)) {
    const { repo, ref, kind } = drift;
    return { repo, ref, kind };
  }
  const { repo, ref, kind, shown, assigned } = drift;
  return { repo, ref, kind, shown, assigned };
}

export function formatDrift(rows: readonly Drift[]): string {
  return toJsonlLine({ [VERSION_FIELD]: DRIFT_STATE_FORMAT, drift: rows.map(rowOf) });
}
