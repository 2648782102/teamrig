import { targetText } from "./host.js";
import { reviewHits } from "../push-guard/review-paths.js";
/**
 * Whether `record` passes `head` (a full lowercase commit id): it says `PASS at <head>` or `PASS at head <head>`, in
 * any case, the head a word of its own. A done security task is done whatever it found, so a record naming the head
 * otherwise (`CHANGES at <head>`, `old head <head> superseded`), a pass of another head or of another change
 * altogether, passes nothing: the merge review gate also binds its pass to one base..head.
 */
export function passesHead(record, head) {
    return new RegExp(`(?<![a-z0-9])pass\\s+at\\s+(?:head\\s+)?${head}(?![0-9a-f])`, 'u').test(record.toLowerCase());
}
/**
 * The changed paths a security entry covers, each once, in their order. A `check` entry counts too, as no review
 * check runs before a GitHub approval; a leader entry does not, as the merge gate still holds it for the leader.
 */
export function gatedPathsIn(paths, entries) {
    const security = entries.filter((entry) => entry.class === 'security');
    return [...new Set(reviewHits(paths, security).map((hit) => hit.path))];
}
/** The gated paths a refusal names at most, so a large change stays one line. */
const SHOWN_PATHS = 3;
/** The verdict as a line says it. */
const DONE_WORD = { approve: 'approved', 'request-changes': 'changes requested' };
/**
 * Posts one review through `host`, one line said for each step: ACCESS, then REVIEWED, or FAILED with the reason and
 * nothing posted. Before the post it reads the pull request: it must be open, its head still the commit the reviewer
 * read (GitHub keeps a review bound to an older commit without a word, so a push after the read is caught here),
 * not opened by the access's own account, and an approval of a change to a security path of the merge review gate must name the security pass.
 * A review is a reviewer's word on GitHub only: it approves no task's wait and merges nothing. True when posted.
 */
export async function reviewPull(host, draft, gate, say) {
    const shown = targetText(draft.target);
    const refused = (reason) => {
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
    const gated = draft.verdict === 'approve' ? await gatedChange(host, draft, gate) : { kind: 'clear' };
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
/**
 * Whether an approval of the pull request clears the gate: it changes no gated path, or the security pass is named
 * and its record names the very head the review is bound to.
 */
async function gatedChange(host, draft, gate) {
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
