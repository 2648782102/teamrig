/**
 * The author ties GitHub gives the people inside a repository: its owner, its organization's members and its
 * collaborators. Every other one (`CONTRIBUTOR` for any merged pull request, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`,
 * `MANNEQUIN`, `NONE`, a deleted author) is outside it.
 */
const INSIDE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
/** Whether an author tie, as GitHub names it, is one inside the repository: its owner, a member or a collaborator. */
export function isInsideAuthor(association) {
    return INSIDE_ASSOCIATIONS.has(association.toUpperCase());
}
/** The trust rules of a team's GitHub config. */
export function trustRules(github) {
    return {
        acceptLabel: github.acceptLabel,
        trustedAuthors: new Set(github.trustedAuthors.map((tie) => tie.toUpperCase())),
        acceptors: new Set(github.acceptors.map((login) => login.toLowerCase())),
    };
}
/** The team's own logins (`OurLogins`); the config keeps `github.owners`' keys in lowercase already. */
export function ourLogins(github) {
    return new Set(Object.keys(github.owners).map((login) => login.toLowerCase()));
}
/**
 * Whether a pull request's author is one of the team's own: the repository's owner, or a login in `ours`. An inside
 * tie alone is not enough (security pass T3030 C9): a collaborator or a member the team never named can push a
 * `t<id>-...` branch, and its news would then reach that task's session as the session's own.
 */
export function isOurAuthor(association, author, ours) {
    return association.toUpperCase() === 'OWNER' || (author !== '' && ours.has(author.toLowerCase()));
}
/** The account kind of a person on GitHub; a `Bot` (an app or a workflow) or an `Organization` never accepts. */
const PERSON = 'User';
/**
 * How far the sync takes `issue`'s text. Only someone with triage rights can label an issue, so a label needs no
 * rights lookup; the two other ways a label lands are refused by its actor: an issue template applies it with the
 * author as actor, a workflow or app with a `Bot` one. An edit of the title or body at or after the accept undoes it
 * (the person who accepted read the older text), until someone adds the label again. With `rules.acceptors` set,
 * only the last accept by one of them counts.
 */
export function issueTrust(issue, rules) {
    if (rules.trustedAuthors.has(issue.authorAssociation.toUpperCase())) {
        return 'trusted';
    }
    if (!issue.labels.some((label) => sameLabel(label, rules.acceptLabel))) {
        return 'untrusted';
    }
    const accept = acceptorLabelled(issue, rules.acceptLabel, rules);
    return accept !== undefined && !editedSince(issue, accept.at) ? 'accepted' : 'untrusted';
}
/**
 * The last time `label` was put on `issue`, when a person other than its author who may accept (`rules.acceptors`)
 * put it on; undefined when the author, a template, a bot or another person put it on last, or when no such event
 * is among the timeline events the host read.
 */
export function acceptorLabelled(issue, label, rules) {
    const last = issue.labelEvents.filter((event) => sameLabel(event.label, label)).at(-1);
    return last !== undefined && byAnotherPerson(last, issue.author) && mayAccept(last, rules) ? last : undefined;
}
/** Whether the person who put the accept label on is one whose accept counts: any, or one of `rules.acceptors`. */
function mayAccept(event, rules) {
    return rules.acceptors.size === 0 || rules.acceptors.has(event.actor.toLowerCase());
}
/** GitHub matches label names without case. */
function sameLabel(name, acceptLabel) {
    return name.trim().toLowerCase() === acceptLabel.trim().toLowerCase();
}
/** A person's account GitHub still has, other than the issue's author. */
function byAnotherPerson(event, author) {
    return event.actorKind === PERSON && event.actor !== '' && event.actor.toLowerCase() !== author.toLowerCase();
}
/** Whether the body or the title changed at or after `at`: an edit in the same second as the accept counts as after it. */
function editedSince(issue, at) {
    const accepted = Date.parse(at);
    return [issue.lastEditedAt, issue.renamedAt].some((edit) => edit !== undefined && Date.parse(edit) >= accepted);
}
