import { afterWrite, fieldsOf, withEntry, withoutEntry } from "./pushed-record.js";
import { STATUS_LABEL_PREFIX } from "./status-push.js";
/**
 * An IssueHost that moves the pushed record (pushed-record.ts) by each status label or assign write teamrig sends, so
 * the push never takes teamrig's own write for a person's: `issue label`, `issue assign`, a claim and the push itself
 * all write through it. Only a write that went is recorded, and only on an issue the record already keeps or one it
 * opened; a close drops the issue. Every read and other write passes through unchanged.
 */
export class RecordingIssueHost {
    name;
    inner;
    store;
    now;
    constructor(inner, store, now) {
        this.name = inner.name;
        this.inner = inner;
        this.store = store;
        this.now = now;
    }
    reach(repo, use) {
        return this.inner.reach(repo, use);
    }
    list(repo, closedSince) {
        return this.inner.list(repo, closedSince);
    }
    pulls(repo, since) {
        return this.inner.pulls(repo, since);
    }
    posts(repo, since) {
        return this.inner.posts(repo, since);
    }
    jobLog(repo, jobId) {
        return this.inner.jobLog(repo, jobId);
    }
    async open(draft) {
        const opened = await this.inner.open(draft);
        if (opened.kind === 'opened') {
            // teamrig wrote every field of an issue it opened, so its entry starts here, and the first push holds nothing.
            const entry = { ...opened.target, ...fieldsOf(draft.labels.filter(isStatusLabel), []), at: this.now() };
            await this.store.update((state) => withEntry(state, entry));
        }
        return opened;
    }
    comment(target, body) {
        return this.inner.comment(target, body);
    }
    editBody(target, body) {
        return this.inner.editBody(target, body);
    }
    async close(target, reason, duplicateId) {
        const end = await this.inner.close(target, reason, duplicateId);
        if (end.kind === 'done') {
            await this.store.update((state) => withoutEntry(state, target));
        }
        return end;
    }
    issueId(target) {
        return this.inner.issueId(target);
    }
    labelExists(repo, label) {
        return this.inner.labelExists(repo, label);
    }
    createLabel(repo, label) {
        return this.inner.createLabel(repo, label);
    }
    async addLabels(target, labels) {
        const status = labels.filter(isStatusLabel);
        return this.recorded(target, await this.inner.addLabels(target, labels), status.length === 0 ? undefined : { kind: 'add-labels', labels: status });
    }
    async removeLabel(target, label) {
        return this.recorded(target, await this.inner.removeLabel(target, label), isStatusLabel(label) ? { kind: 'remove-label', label } : undefined);
    }
    links(repo) {
        return this.inner.links(repo);
    }
    addSubIssue(parent, childId) {
        return this.inner.addSubIssue(parent, childId);
    }
    addBlockedBy(target, blockerId) {
        return this.inner.addBlockedBy(target, blockerId);
    }
    assigneeExists(repo, login) {
        return this.inner.assigneeExists(repo, login);
    }
    async assign(target, logins) {
        return this.recorded(target, await this.inner.assign(target, logins), { kind: 'assign', logins });
    }
    watch(repo, marks) {
        return this.inner.watch(repo, marks);
    }
    async unassign(target, login) {
        return this.recorded(target, await this.inner.unassign(target, login), { kind: 'unassign', login });
    }
    newComments(target, since) {
        return this.inner.newComments(target, since);
    }
    /** `end`, once a write that went has moved the record; a failed write, or one with nothing to record, moves none. */
    async recorded(target, end, write) {
        if (end.kind === 'done' && write !== undefined) {
            const at = this.now();
            await this.store.update((state) => afterWrite(state, target, write, at));
        }
        return end;
    }
}
function isStatusLabel(label) {
    return label.startsWith(STATUS_LABEL_PREFIX);
}
