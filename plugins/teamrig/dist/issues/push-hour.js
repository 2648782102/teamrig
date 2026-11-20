import { isRecord } from "../core/guards.js";
import { parseObject, toJsonlLine, VERSION_FIELD } from "../core/jsonl.js";
/**
 * The automatic push's writes over the rolling hour (T4592): a count per minute the push sent in, kept in one small
 * file between runs, so a run sends what the hour has left instead of an even share of it. The share split the hour
 * by the most runs the probe interval allows, 4 writes a run at a probe a minute, so a backlog of 78 changes took
 * 20 runs even when the watch ran a sync only a few times an hour. A minute's count stays until the whole minute is
 * an hour old, so the sum never counts fewer writes than GitHub's own hour does; at worst it counts a minute too many.
 */
/** The version the hour file is written in; a file of any other is unreadable, and the run falls back to the share. */
export const PUSH_HOUR_FORMAT = 1;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The hour file's text, or undefined when there is no file yet: that is an hour with no writes in it. */
export function parsePushHour(text) {
    if (text === undefined) {
        return { kind: 'read', hour: [] };
    }
    const record = parseObject(text.trim());
    if (record === undefined) {
        return { kind: 'unreadable', reason: 'not a JSON object' };
    }
    if (record[VERSION_FIELD] !== PUSH_HOUR_FORMAT) {
        return { kind: 'unreadable', reason: `format ${String(record[VERSION_FIELD])}, not ${PUSH_HOUR_FORMAT}` };
    }
    const minutes = record['minutes'];
    if (!Array.isArray(minutes)) {
        return { kind: 'unreadable', reason: 'no minutes list' };
    }
    const hour = [];
    for (const value of minutes) {
        if (!isPushMinute(value)) {
            return { kind: 'unreadable', reason: 'a minute that is not a minute start and a count of writes' };
        }
        hour.push({ minute: value.minute, writes: value.writes });
    }
    return { kind: 'read', hour: hour.sort((a, b) => a.minute - b.minute) };
}
function isPushMinute(value) {
    if (!isRecord(value)) {
        return false;
    }
    const { minute, writes } = value;
    return typeof minute === 'number' && Number.isSafeInteger(minute) && minute % MINUTE_MS === 0 && typeof writes === 'number' && Number.isSafeInteger(writes) && writes >= 0;
}
/** Whether a minute still counts at `now`: any part of it within the last hour. */
function inHour(entry, now) {
    return entry.minute + MINUTE_MS > now - HOUR_MS;
}
/** The writes sent in the hour up to `now`. */
export function hourSent(hour, now) {
    return hour.filter((entry) => inHour(entry, now)).reduce((sum, entry) => sum + entry.writes, 0);
}
/** The start of the minute `at` falls in. */
export function minuteOf(at) {
    return Math.floor(at / MINUTE_MS) * MINUTE_MS;
}
/**
 * The hour at `now` with `delta` writes added to `minute`'s count (taken off, for a negative delta, down to none): the
 * minutes past the hour dropped, and a minute left with no writes too. A run reserves its limit in its own minute
 * before it sends, then settles it to what it sent, so a run that stops half way leaves the hour counted high.
 */
export function shiftWrites(hour, now, minute, delta) {
    const kept = hour.filter((entry) => inHour(entry, now));
    const same = kept.find((entry) => entry.minute === minute);
    const others = kept.filter((entry) => entry.minute !== minute);
    const writes = Math.max(0, (same?.writes ?? 0) + delta);
    const shifted = writes > 0 && inHour({ minute, writes }, now) ? [...others, { minute, writes }] : others;
    return shifted.sort((a, b) => a.minute - b.minute);
}
/** The hour file's text. */
export function pushHourText(hour) {
    return toJsonlLine({ [VERSION_FIELD]: PUSH_HOUR_FORMAT, minutes: hour.map(({ minute, writes }) => ({ minute, writes })) });
}
