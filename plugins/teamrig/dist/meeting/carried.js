import { cardLabel, decisionKey } from "./decision-order.js";
import { isOwnerAnswer } from "./notices.js";
/**
 * The ids of the tasks given an owner's answer (isOwnerAnswer) since `since`, recorded by `by`, or by anyone when it
 * is undefined: a booked meeting's session met records its own answers.
 */
export function answeredIds(events, since, by) {
    const ids = new Set();
    for (const event of events) {
        if (event.type === 'update' && (by === undefined || event.by === by) && Date.parse(event.at) >= since && isOwnerAnswer(event)) {
            ids.add(event.id);
        }
    }
    return ids;
}
/** The keys (decisionKey) of the cards the lead recorded an owner's answer on since `since`, over every register read. */
export function answeredKeys(reads, since) {
    return new Set(reads.flatMap(({ events, decidedBy, team }) => [...answeredIds(events, since, decidedBy)].map((id) => cardLabel(team, id))));
}
/** The keys of the cards asked, in the agenda's order, that got no answer: those the meeting carries over. */
export function carriedKeys(asked, answered) {
    return asked.map(decisionKey).filter((key) => !answered.has(key));
}
