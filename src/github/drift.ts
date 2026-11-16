/**
 * GH-DRIFT (T3205): a GitHub thread whose labels disagree with what is happening on it, so a contributor reading the
 * issue is misled (issue #922: a pull request was open on it while it still showed `status:open`). Pure: the writing
 * sync finds the drift in the issues it read and keeps it in its own state file under the sync's lock
 * (src/cli/commands/issue-drift.ts), and `check` shows each row to the lead with no GitHub call
 * (src/cli/github-drift-check.ts).
 */

import { isRecord } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import type { HostIssue } from '../issues/issue.ts';
import { STATUS_LABEL_PREFIX, STATUS_LABELS } from '../issues/status-push.ts';
import { issueRef } from './map.ts';

/** The kinds of drift: `linked-pull`, an open issue an open pull request closes that does not show `status:in review`. */
export const DRIFT_KINDS = ['linked-pull'] as const;

export type DriftKind = (typeof DRIFT_KINDS)[number];

/** One thread out of step, as the last read of its repository saw it. */
export interface Drift {
  /** `owner/name`. */
  readonly repo: string;
  /** As the task list names it (github/map.ts issueRef). */
  readonly ref: string;
  readonly kind: DriftKind;
  /** The `status:` labels it showed, in the host's order; empty for none. */
  readonly shown: readonly string[];
  /** Whether anyone was assigned to it. */
  readonly assigned: boolean;
}

/** The drift on one issue as read: none on a closed one. GitHub matches label names without case, so this does too. */
export function issueDrift(issue: HostIssue): Drift[] {
  if (issue.state !== 'open' || issue.linkedPulls === 0) {
    return [];
  }
  const shown = issue.labels.filter((label) => label.toLowerCase().startsWith(STATUS_LABEL_PREFIX));
  if (shown.some((label) => label.toLowerCase() === STATUS_LABELS.verifying)) {
    return [];
  }
  return [{ repo: issue.repo, ref: issueRef(issue.repo, issue.number), kind: 'linked-pull', shown, assigned: issue.assignees.length > 0 }];
}

/**
 * The drift after a read of the repositories in `read`: each one read gives what it found now, so a thread set right
 * drops out; a repository not read this time (it failed) keeps its rows as they were.
 */
export function stepDrift(before: readonly Drift[], read: ReadonlySet<string>, found: readonly Drift[]): Drift[] {
  return [...before.filter((drift) => !read.has(drift.repo)), ...found.filter((drift) => read.has(drift.repo))];
}

/** What names a row while it stands, so the lead is told of it once. */
export function driftKey(drift: Pick<Drift, 'ref' | 'kind'>): string {
  return `gh-drift ${drift.ref} ${drift.kind}`;
}

/** The lead's GH-DRIFT line for a row. */
export function driftText(drift: Drift): string {
  const shows = drift.shown.length === 0 ? 'no status label' : drift.shown.join(', ');
  const assignee = drift.assigned ? '' : ' and no assignee';
  return (
    `GH-DRIFT ${drift.ref}: an open pull request closes it, yet it shows ${shows}${assignee}, not ${STATUS_LABELS.verifying}: ` +
    `have its task's owner set it verifying, or the pull request's author unlink it`
  );
}

/** The format of the drift file this code writes; a file in another format, or damaged, reads as no drift. */
export const DRIFT_STATE_FORMAT = 1;

/** The rows a file holds; a damaged row is left out, a damaged file reads as none. */
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
  if (typeof repo !== 'string' || typeof ref !== 'string' || !isDriftKind(kind) || !isTextList(shown) || typeof assigned !== 'boolean') {
    return [];
  }
  return [{ repo, ref, kind, shown, assigned }];
}

function isDriftKind(value: unknown): value is DriftKind {
  return DRIFT_KINDS.some((kind) => kind === value);
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function formatDrift(rows: readonly Drift[]): string {
  return toJsonlLine({ [VERSION_FIELD]: DRIFT_STATE_FORMAT, drift: rows.map(({ repo, ref, kind, shown, assigned }) => ({ repo, ref, kind, shown, assigned })) });
}
