import { LOCAL_REF_PREFIX } from "../register/model.js";
/**
 * Why a task never gets a public issue, or undefined when its wording decides (T3349). The wording check
 * (`publicIssueText`, migrate.ts) catches a secret's shape and private data, not a security hole told in plain words,
 * so the tasks likeliest to hold one stay off GitHub by what they are: one whose ref says why it stays local, a
 * critical bug, and one the security reviewer (`roles.securityReviewer`) owns. Nothing overrides the last two; a local
 * ref gives way only once its owner clears it (`update --ref none`), a choice made on the task, never by an issue
 * command.
 */
export function offGitHubReason(task, securityReviewer) {
    if (task.ref?.startsWith(LOCAL_REF_PREFIX) === true) {
        return 'its ref keeps it local; clear that ref first (update --ref none) once it may be public';
    }
    if (task.type === 'bug' && task.critical) {
        return 'it is a critical bug, whose issue could tell a security hole';
    }
    if (securityReviewer !== undefined && task.owner === securityReviewer) {
        return `the security reviewer (${securityReviewer}) owns it`;
    }
    return undefined;
}
