import { stringField } from "../core/guards.js";
import { parseObject } from "../core/jsonl.js";
import { CARRY_TAIL_BYTES, carryOf } from "./carry.js";
/** Enough of the transcript to hold its last entry: the fire's entry carries the job's prompt. */
export const SCHEDULED_TAIL_BYTES = 64 * 1024;
/**
 * Whether the prompt a UserPromptSubmit hook sees was fired by a scheduled job (CronCreate) rather than typed: its
 * payload says neither way, but Claude Code writes the fire's `system`/`scheduled_task_fire` entry before the hook
 * runs and the prompt's own entry only after, so the transcript then ends with the fire. A typed prompt's
 * transcript ends with the last turn's entries instead.
 */
export function endsWithScheduledFire(tail) {
    const lines = tail.split('\n').filter((line) => line.trim() !== '');
    const last = lines.length === 0 ? undefined : parseObject((lines[lines.length - 1] ?? '').trim());
    return last !== undefined && stringField(last, 'type') === 'system' && stringField(last, 'subtype') === 'scheduled_task_fire';
}
/**
 * Whether the prompt was fired by a scheduled job: its transcript ends with a fire (`endsWithScheduledFire`) and the
 * prompt is a live job's (`carryOf` at `now`, counting the jobs a /clear left in the process: `inherited`). Claude
 * Code also writes a fire entry when it folds fires that ran nothing, so a transcript can end with one while a person
 * types; their prompt matches no live job and stays typed. False when the transcript is unknown or missing; a read that
 * fails throws, and the hook takes the prompt as typed.
 */
export async function firedBySchedule(files, seen, inherited, now) {
    const { transcript, prompt } = seen;
    if (transcript === undefined || prompt === undefined) {
        return false;
    }
    // The short tail answers most prompts; the whole carry window is read only after a fire.
    const tail = await files.readTail(transcript, SCHEDULED_TAIL_BYTES);
    if (tail === undefined || !endsWithScheduledFire(tail)) {
        return false;
    }
    const text = await files.readTail(transcript, CARRY_TAIL_BYTES);
    const typed = prompt.trim();
    return text !== undefined && carryOf(text, now, inherited).crons.some((cron) => cron.prompt.trim() === typed);
}
