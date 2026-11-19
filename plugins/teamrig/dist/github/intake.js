import { MAX_DESCRIPTION } from "../config/defaults.js";
import { targetText } from "../issues/host.js";
import { PULL_FILES_PAGE } from "./gh.js";
/** The title of the reply task, which marks the pull request as taken in: a second intake of it is refused. */
export function intakeReplyTitle(target) {
    return `Reply to outside PR ${targetText(target)} once its reviews are in`;
}
export function intakePlan(input) {
    const { target, files, areas, caller } = input;
    const shown = targetText(target);
    const split = areas.split(target.repo, files.paths);
    const own = split.owners.find((share) => share.session === caller)?.paths ?? [];
    const asks = split.owners
        .filter((share) => share.session !== caller)
        .map((share) => ({
        kind: 'area',
        owner: share.session,
        // The register refuses an active task's title again whoever owns it, so each owner's ask names that owner.
        title: `Best-fix and overlap review of outside PR ${shown} for ${share.session}`,
        description: described(`Review outside PR ${shown} in your area: is its fix the best one, and does it overlap your open tasks? Say your verdict on this task; ${caller} replies to the author once every review is in. Your paths, as the PR names them:`, share.paths),
    }));
    const guarded = files.paths.filter((path) => input.isSecurityPath(path));
    const unseen = unseenNotes(files);
    const reviewer = input.securityReviewer;
    // A file the read could not see may be guarded, so the security review is asked whenever one is unseen: which files
    // fill the one page is the author's choice, and it must not decide who reviews.
    if ((guarded.length > 0 || unseen.length > 0) && reviewer !== undefined) {
        const why = guarded.length > 0 ? 'which changes guarded paths' : 'whose files the read could not all see';
        const head = `Security review of outside PR ${shown}, ${why}, in parallel with its area reviews. Say your verdict on this task; ${caller} replies to the author once every review is in. ${unseen.join(' ')}`.trimEnd();
        asks.push({
            kind: 'security',
            owner: reviewer,
            title: `Security review of outside PR ${shown}`,
            description: guarded.length === 0 ? head : described(`${head} The guarded paths, as the PR names them:`, guarded),
        });
    }
    return { asks, reply: { title: intakeReplyTitle(target), description: replyDescription(input, shown, [...own, ...split.unowned], guarded.length > 0 && reviewer === undefined) } };
}
/** The reply task's text: what to review itself, what the read could not see, and when to answer. */
function replyDescription(input, shown, yours, guardedUnasked) {
    const { files } = input;
    const notes = [
        ...unseenNotes(files),
        ...(guardedUnasked ? ['It changes guarded paths and no one but you reviews them: set roles.securityReviewer.'] : []),
    ];
    const head = `Answer the author of outside PR ${shown} once every review task this depends on is done: the best fix, or the change asked. ${notes.join(' ')}`.trimEnd();
    return yours.length === 0 ? head : described(`${head} Yours to review, owned by no other area:`, yours);
}
/** What the read could not see, a sentence each: a full page may have more files after it, and a name left out may be any path. */
function unseenNotes(files) {
    return [
        ...(files.listed >= PULL_FILES_PAGE ? [`The read gave its first ${PULL_FILES_PAGE} files only: review the rest on GitHub.`] : []),
        ...(files.leftOut > 0 ? [`${files.leftOut} file name(s) were no plain path and were left out: read them on GitHub.`] : []),
    ];
}
/** `head`, then the paths quoted as JSON, as many as fit a task's description, the rest counted. */
function described(head, paths) {
    const quoted = paths.map((path) => JSON.stringify(path));
    for (let kept = quoted.length; kept > 0; kept -= 1) {
        const left = quoted.length - kept;
        const text = `${head} ${[...quoted.slice(0, kept), ...(left === 0 ? [] : [`and ${left} more`])].join(', ')}`;
        if (text.length <= MAX_DESCRIPTION) {
            return text;
        }
    }
    return `${head} ${quoted.length} path(s), too long to list: read them on GitHub`;
}
