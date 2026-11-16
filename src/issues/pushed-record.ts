import { isRecord, isStringArray } from '../core/guards.ts';
import { parseObject, toJsonlLine, VERSION_FIELD } from '../core/jsonl.ts';
import { targetText, type IssueTarget } from './host.ts';

/**
 * What teamrig last left on each issue its status push keeps: the status labels and the assignees, as they stood
 * after teamrig's own write. The push holds a field that differs from it, as a person changed it since (T3230): a
 * status label set or taken off by hand, or an assignee changed, is theirs until the task's status matches it again.
 * This file holds the record and its decisions only; the CLI reads and writes it under the sync lock.
 */

/** The record's format; a file of another format reads as empty, so the next push starts it again from the issues. */
export const PUSHED_FORMAT = 1;

/** The fields of one issue the push compares: its status labels and its assignees. */
export interface PushedFields {
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

/** What teamrig last left on one issue, and when (ms since the epoch). */
export interface PushedEntry extends IssueTarget, PushedFields {
  readonly at: number;
}

/** The record, by issue (`owner/name#n`). */
export type PushedState = ReadonlyMap<string, PushedEntry>;

/** The fields the push compares, in one order: `labels` (the status labels alone, as the caller gives them) and the logins in lower case. */
export function fieldsOf(labels: readonly string[], assignees: readonly string[]): PushedFields {
  return {
    labels: [...new Set(labels)].sort(),
    assignees: [...new Set(assignees.map((login) => login.toLowerCase()))].sort(),
  };
}

/** The record held in `text`; a missing, unreadable or other-format file is an empty record. */
export function parsePushed(text: string): PushedState {
  const record = parseObject(text.trim());
  const issues = record?.[VERSION_FIELD] === PUSHED_FORMAT ? record['issues'] : undefined;
  const entries = Array.isArray(issues) ? issues.flatMap(entryOf) : [];
  return new Map(entries.map((entry) => [targetText(entry), entry]));
}

function entryOf(value: unknown): PushedEntry[] {
  if (!isRecord(value)) {
    return [];
  }
  const { repo, number, labels, assignees, at } = value;
  const valid =
    typeof repo === 'string' &&
    repo !== '' &&
    typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    isStringArray(labels) &&
    isStringArray(assignees) &&
    typeof at === 'number' &&
    Number.isFinite(at);
  return valid ? [{ repo, number, ...fieldsOf(labels, assignees), at }] : [];
}

/** The record as one line of JSON, issues in order. */
export function formatPushed(state: PushedState): string {
  const issues = [...state.values()].sort((a, b) => (a.repo === b.repo ? a.number - b.number : a.repo < b.repo ? -1 : 1));
  return toJsonlLine({
    [VERSION_FIELD]: PUSHED_FORMAT,
    issues: issues.map(({ repo, number, labels, assignees, at }) => ({ repo, number, labels, assignees, at })),
  });
}

/** Which of an issue's fields a person changed since teamrig's last write: each that differs from the record. */
export interface PushedHold {
  readonly labels: boolean;
  readonly assignees: boolean;
}

/** The fields of `now` that differ from `entry`; with no entry, none, as the issue's fields are where the record starts. */
export function heldFields(entry: PushedEntry | undefined, now: PushedFields): PushedHold {
  if (entry === undefined) {
    return { labels: false, assignees: false };
  }
  return { labels: !sameList(entry.labels, now.labels), assignees: !sameList(entry.assignees, now.assignees) };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** One write teamrig sent to an issue, as the record takes it. */
export type PushedWrite =
  | { readonly kind: 'add-labels'; readonly labels: readonly string[] }
  | { readonly kind: 'remove-label'; readonly label: string }
  | { readonly kind: 'assign'; readonly logins: readonly string[] }
  | { readonly kind: 'unassign'; readonly login: string };

/**
 * `state` after teamrig's `write` to `target` at `at`: the issue's entry moved by the write. An issue with no entry
 * keeps none, as the record starts only where the push planned against the issue's own fields.
 */
export function afterWrite(state: PushedState, target: IssueTarget, write: PushedWrite, at: number): PushedState {
  const key = targetText(target);
  const entry = state.get(key);
  if (entry === undefined) {
    return state;
  }
  const next = new Map(state);
  next.set(key, { repo: entry.repo, number: entry.number, ...fieldsOf(...moved(entry, write)), at });
  return next;
}

function moved(entry: PushedEntry, write: PushedWrite): [readonly string[], readonly string[]] {
  switch (write.kind) {
    case 'add-labels':
      return [[...entry.labels, ...write.labels], entry.assignees];
    case 'remove-label':
      return [entry.labels.filter((label) => label !== write.label), entry.assignees];
    case 'assign':
      return [entry.labels, [...entry.assignees, ...write.logins]];
    case 'unassign':
      return [entry.labels, entry.assignees.filter((login) => login !== write.login.toLowerCase())];
  }
}

/** `state` with `entry` set, replacing the issue's last one. */
export function withEntry(state: PushedState, entry: PushedEntry): PushedState {
  const next = new Map(state);
  next.set(targetText(entry), entry);
  return next;
}

/** `state` without the issue, as for one the push closed. */
export function withoutEntry(state: PushedState, target: IssueTarget): PushedState {
  const key = targetText(target);
  if (!state.has(key)) {
    return state;
  }
  const next = new Map(state);
  next.delete(key);
  return next;
}
