import { MS_PER_MINUTE } from '../core/time.ts';
import type { ScheduledMeeting } from './schedule.ts';

/**
 * `meeting postpone` (T2775, design T2773 D): a meeting the owner cannot finish now moves what is still open to a later
 * slot and keeps what was decided. The daily meeting ends, its open cards carry over (carried.ts), and a time names a
 * booked meeting with the lead for them; a booked M<n> goes back to scheduled at the new time with only its open tasks,
 * so one meeting keeps one thread.
 */

/** The furthest `--in` reaches: a day; a later slot is a time, `--at`. */
export const POSTPONE_IN_MAX_MINUTES = 24 * 60;

/** Where a postponed meeting goes: a set time, or the next daily meeting (the daily one's `--tomorrow`). */
export type PostponeTo = { readonly kind: 'at'; readonly at: number } | { readonly kind: 'next-daily' };

/** `--in 45m` or `--in 2h`: the minutes, from 1 to POSTPONE_IN_MAX_MINUTES; undefined for any other text. */
export function minutesIn(text: string): number | undefined {
  const match = /^(\d{1,4})\s*(m|h)$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const minutes = Number(match[1]) * (match[2] === 'h' ? 60 : 1);
  return minutes >= 1 && minutes <= POSTPONE_IN_MAX_MINUTES ? minutes : undefined;
}

/** The time `minutes` from `now`, in ms. */
export function inMinutes(now: number, minutes: number): number {
  return now + minutes * MS_PER_MINUTE;
}

/** What is left of a booked meeting held in part: its tasks with no answer, in their order, and how many got one. */
export interface Rest {
  readonly tasks: readonly string[];
  readonly decided: number;
}

/** The rest of `meeting` once the tasks in `answered` got the owner's answer. */
export function restOf(meeting: ScheduledMeeting, answered: ReadonlySet<string>): Rest {
  const tasks = meeting.tasks.filter((id) => !answered.has(id));
  return { tasks, decided: meeting.tasks.length - tasks.length };
}

/** The note a postponed started meeting keeps: when it was held, and how many of its tasks it settled. */
export function partHeldNote(heldAt: string, rest: Rest, note: string | null): string {
  const part = `part held ${heldAt}: ${rest.decided} of ${rest.decided + rest.tasks.length} decided`;
  return note === null ? part : `${part}; ${note}`;
}
