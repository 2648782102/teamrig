import type {
  CloseReason,
  HostAssignee,
  HostComments,
  HostEnd,
  HostIssueId,
  HostJobLog,
  HostLabel,
  HostLinks,
  HostList,
  HostOpen,
  HostPulls,
  HostReach,
  HostUse,
  HostWatch,
  IssueDraft,
  IssueHost,
  IssueTarget,
  LabelSpec,
  WatchMarks,
} from './host.ts';
import { afterWrite, fieldsOf, withEntry, withoutEntry, type PushedState, type PushedWrite } from './pushed-record.ts';
import { STATUS_LABEL_PREFIX } from './status-push.ts';

/** Where the pushed record is kept: read whole, and each change read, made and written back whole under the store's own lock. */
export interface PushedStore {
  read(): Promise<PushedState>;
  update(change: (state: PushedState) => PushedState): Promise<void>;
}

/**
 * An IssueHost that moves the pushed record (pushed-record.ts) by each status label or assign write teamrig sends, so
 * the push never takes teamrig's own write for a person's: `issue label`, `issue assign`, a claim and the push itself
 * all write through it. Only a write that went is recorded, and only on an issue the record already keeps or one it
 * opened; a close drops the issue. Every read and other write passes through unchanged.
 */
export class RecordingIssueHost implements IssueHost {
  readonly name: string;
  private readonly inner: IssueHost;
  private readonly store: PushedStore;
  private readonly now: () => number;

  constructor(inner: IssueHost, store: PushedStore, now: () => number) {
    this.name = inner.name;
    this.inner = inner;
    this.store = store;
    this.now = now;
  }

  reach(repo: string, use: HostUse): Promise<HostReach> {
    return this.inner.reach(repo, use);
  }

  list(repo: string, closedSince: string): Promise<HostList> {
    return this.inner.list(repo, closedSince);
  }

  pulls(repo: string, since: string | undefined): Promise<HostPulls> {
    return this.inner.pulls(repo, since);
  }

  jobLog(repo: string, jobId: number): Promise<HostJobLog> {
    return this.inner.jobLog(repo, jobId);
  }

  async open(draft: IssueDraft): Promise<HostOpen> {
    const opened = await this.inner.open(draft);
    if (opened.kind === 'opened') {
      // teamrig wrote every field of an issue it opened, so its entry starts here, and the first push holds nothing.
      const entry = { ...opened.target, ...fieldsOf(draft.labels.filter(isStatusLabel), []), at: this.now() };
      await this.store.update((state) => withEntry(state, entry));
    }
    return opened;
  }

  comment(target: IssueTarget, body: string): Promise<HostEnd> {
    return this.inner.comment(target, body);
  }

  editBody(target: IssueTarget, body: string): Promise<HostEnd> {
    return this.inner.editBody(target, body);
  }

  async close(target: IssueTarget, reason?: CloseReason, duplicateId?: number): Promise<HostEnd> {
    const end = await this.inner.close(target, reason, duplicateId);
    if (end.kind === 'done') {
      await this.store.update((state) => withoutEntry(state, target));
    }
    return end;
  }

  issueId(target: IssueTarget): Promise<HostIssueId> {
    return this.inner.issueId(target);
  }

  labelExists(repo: string, label: string): Promise<HostLabel> {
    return this.inner.labelExists(repo, label);
  }

  createLabel(repo: string, label: LabelSpec): Promise<HostEnd> {
    return this.inner.createLabel(repo, label);
  }

  async addLabels(target: IssueTarget, labels: readonly string[]): Promise<HostEnd> {
    const status = labels.filter(isStatusLabel);
    return this.recorded(target, await this.inner.addLabels(target, labels), status.length === 0 ? undefined : { kind: 'add-labels', labels: status });
  }

  async removeLabel(target: IssueTarget, label: string): Promise<HostEnd> {
    return this.recorded(target, await this.inner.removeLabel(target, label), isStatusLabel(label) ? { kind: 'remove-label', label } : undefined);
  }

  links(repo: string): Promise<HostLinks> {
    return this.inner.links(repo);
  }

  addSubIssue(parent: IssueTarget, childId: number): Promise<HostEnd> {
    return this.inner.addSubIssue(parent, childId);
  }

  addBlockedBy(target: IssueTarget, blockerId: number): Promise<HostEnd> {
    return this.inner.addBlockedBy(target, blockerId);
  }

  assigneeExists(repo: string, login: string): Promise<HostAssignee> {
    return this.inner.assigneeExists(repo, login);
  }

  async assign(target: IssueTarget, logins: readonly string[]): Promise<HostEnd> {
    return this.recorded(target, await this.inner.assign(target, logins), { kind: 'assign', logins });
  }

  watch(repo: string, marks: WatchMarks): Promise<HostWatch> {
    return this.inner.watch(repo, marks);
  }

  async unassign(target: IssueTarget, login: string): Promise<HostEnd> {
    return this.recorded(target, await this.inner.unassign(target, login), { kind: 'unassign', login });
  }

  newComments(target: IssueTarget, since: number): Promise<HostComments> {
    return this.inner.newComments(target, since);
  }

  /** `end`, once a write that went has moved the record; a failed write, or one with nothing to record, moves none. */
  private async recorded(target: IssueTarget, end: HostEnd, write: PushedWrite | undefined): Promise<HostEnd> {
    if (end.kind === 'done' && write !== undefined) {
      const at = this.now();
      await this.store.update((state) => afterWrite(state, target, write, at));
    }
    return end;
  }
}

function isStatusLabel(label: string): boolean {
  return label.startsWith(STATUS_LABEL_PREFIX);
}
