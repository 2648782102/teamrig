import { ENV } from "../../core/home.js";
import { issueRef } from "../../github/map.js";
import { fitIssueFields, wantedFields } from "../../issues/issue-fields.js";
import { hostOf } from "../issue-hosts.js";
import { EXIT, RefusedError } from "../runtime.js";
import { GITHUB_OFF, githubOff } from "./issue-sync-auto.js";
/** The flags of `add` that ask about the new task's issue (github/issue-at-add.ts). */
export const ADD_ISSUE_FLAGS = ['issue', 'issue-body', 'issue-repo', 'local'];
/** What an add asked about its issue: its issue flags, with the task's own ref, type, priority, owner (an id) and critical mark. */
export function addIssueAskOf(flags, input) {
    return {
        title: flags.get('issue'),
        body: flags.get('issue-body'),
        repo: flags.get('issue-repo'),
        local: flags.get('local'),
        ref: input.ref,
        type: input.type,
        priority: input.priority,
        owner: input.owner,
        critical: input.critical ?? false,
    };
}
/**
 * The host a new task's issue opens on: GitHub, with the token saved for the repository's owner, or none while GitHub is
 * off here. stamp is the team's github.stamp: whether the issue's body ends with the made-with-teamrig footer.
 */
export function addIssueHost(runtime, scanner, stamp) {
    return githubOff(runtime.env) ? undefined : hostOf('github', runtime, scanner, stamp);
}
/** The judged task as its issue's fields read it: a task an add writes always starts open. */
function newTaskFields(fields) {
    return { type: fields.type, after: fields.after, due: fields.due, owner: fields.owner, status: 'open' };
}
/**
 * Adds a task with its issue, all or nothing: the add is judged, the issue opened with the type, status and area
 * labels and assignee the judged task calls for (issues/issue-fields.ts, each one the repository has), then the task
 * written with its ref pointing at it, so the sync adds no second task for it. A refused add, GitHub off here or a
 * GitHub failure writes nothing and opens nothing. A write the register refuses after the issue opened (a task written
 * between the two) closes the issue as not planned, or says to close it by hand when that fails; the caller reports
 * the refusal.
 */
export async function addWithIssue(say, register, host, by, input, draft, rules) {
    const judged = await register.judgeAdd(by, input);
    if (!judged.ok) {
        throw new RefusedError(judged.error);
    }
    if (host === undefined) {
        throw new RefusedError(`${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine, so the new task's issue cannot open and nothing is written: turn GitHub on, or add the task with --local <reason>`);
    }
    const reach = await host.reach(draft.repo, 'open');
    if (reach.kind === 'unreachable') {
        say(`FAILED the new task's issue: ${reach.reason}; nothing is written`);
        return { kind: 'stopped', code: EXIT.failed };
    }
    const fitted = await fitIssueFields(host, draft, wantedFields(newTaskFields(judged.value), draft, rules));
    fitted.skipped.forEach(say);
    const opened = await host.open(fitted.draft);
    if (opened.kind === 'failed') {
        say(`FAILED the new task's issue: ${opened.reason}; nothing is written`);
        return { kind: 'stopped', code: EXIT.failed };
    }
    const ref = issueRef(opened.target.repo, opened.target.number);
    const verdict = await register.add(by, { ...input, ref });
    if (!verdict.ok) {
        const closed = await host.close(opened.target, 'not-planned');
        say(closed.kind === 'done' ? `CLOSED ${ref} as not planned: the task it opened for was refused` : `FAILED to close ${ref}: ${closed.reason}; close it by hand, the task it opened for was refused`);
    }
    return { kind: 'written', verdict, ref };
}
