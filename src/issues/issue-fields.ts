import type { IssueFieldsConfig } from '../config/types.ts';
import type { Task } from '../register/fold.ts';
import { firstTypeIn, kindOf } from './field-push.ts';
import type { HostTypesRead } from './fields.ts';
import type { IssueDraft, IssueHost } from './host.ts';
import { managedLabel } from './managed-labels.ts';
import { assigneeOf, issueGoal, sessionLogins, type SessionLogins } from './status-push.ts';

/**
 * What an issue teamrig opens for a task carries from its first moment (T3349): the issue type the field push would
 * set (`github.fields.types` for the task's kind, field-push.ts kindOf), the status label and the assignee the status
 * push would give it (status-push.ts issueGoal), and the area label of the session that owns the task. All go in the
 * one create, so the issue never shows untyped, unlabelled or unassigned in between. The repository is read first
 * (fitIssueFields): a type, label or login it lacks is left out with a line saying so, never guessed at, and a status
 * label it lacks is made, as the push makes it.
 */

/** What the team's config says about a new issue: each session's login, each area label's session, and the issue types each kind takes. */
export interface IssueRules {
  readonly logins: SessionLogins;
  /** Each area label to the session its issues go to (`github.areaOwners`), in the config's order. */
  readonly areaOwners: ReadonlyMap<string, string>;
  /** `github.fields`: the types each kind is set as, and `push`, which off sets none. */
  readonly fields: Pick<IssueFieldsConfig, 'push' | 'types'>;
}

/** The rules of the team's `github` config: `owners` (login to session), `areaOwners` (area label to session) and `fields`. */
export function issueRulesOf(github: {
  readonly owners: Readonly<Record<string, string>>;
  readonly areaOwners: Readonly<Record<string, string>>;
  readonly fields: Pick<IssueFieldsConfig, 'push' | 'types'>;
}): IssueRules {
  return { logins: sessionLogins(github.owners), areaOwners: new Map(Object.entries(github.areaOwners)), fields: github.fields };
}

/** The fields a task's new issue is opened with besides its wording and its kind and priority labels. */
export interface WantedFields {
  /** The issue types it may take, in the config's order: the first the repository has wins; none sets no type. */
  readonly types: readonly string[];
  /** The status label, then the owner's area label; each one the task calls for. */
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

/** The task facts the fields come from. */
export type FieldTask = Pick<Task, 'type' | 'after' | 'status' | 'due' | 'owner'>;

/**
 * The fields `task`'s new issue `draft` takes: the types `rules` gives its kind (a design issue by the draft's labels;
 * none while the field push is off); the status label and the assignee the push would set (a started, waiting or
 * scheduled task is assigned to its owner's login, else the repository's owner); and the first area label `rules`
 * gives the task's owner.
 */
export function wantedFields(task: FieldTask, draft: Pick<IssueDraft, 'repo' | 'labels'>, rules: IssueRules): WantedFields {
  const goal = issueGoal(task, { assigned: false, design: false });
  const status = goal.open && goal.label !== undefined ? [goal.label] : [];
  const area = [...rules.areaOwners].find(([, session]) => session === task.owner)?.[0];
  return {
    types: rules.fields.push ? rules.fields.types[kindOf(task, draft.labels)] : [],
    labels: [...status, ...(area === undefined ? [] : [area])],
    assignees: goal.open && goal.claim ? [assigneeOf(draft.repo, task.owner, rules.logins)] : [],
  };
}

/** The fields as one line for a preview: `type Task, labels status:open, assigned octocat`. */
export function fieldsText(wanted: WantedFields): string {
  const type = wanted.types[0] === undefined ? 'no type' : `type ${wanted.types[0]}`;
  const labels = wanted.labels.length === 0 ? 'no status or area label' : `labels ${wanted.labels.join(', ')}`;
  const assignees = wanted.assignees.length === 0 ? 'unassigned' : `assigned ${wanted.assignees.join(', ')}`;
  return `${type}, ${labels}, ${assignees}`;
}

/**
 * The issue types of each repository a command opens issues in, read once per repository through the host's fields
 * capability (one small query, fields.ts IssueFields.types), so `issue migrate` opening many issues reads them once.
 */
export class RepoTypes {
  private readonly reads = new Map<string, Promise<HostTypesRead>>();
  private readonly host: IssueHost;

  constructor(host: IssueHost) {
    this.host = host;
  }

  /** The enabled types of `repo`; undefined when the tracker has no issue types at all. */
  of(repo: string): Promise<HostTypesRead> | undefined {
    const fields = this.host.fields;
    if (fields === undefined) {
      return undefined;
    }
    const key = repo.toLowerCase();
    const known = this.reads.get(key);
    if (known !== undefined) {
      return known;
    }
    const read = fields.types(repo);
    this.reads.set(key, read);
    return read;
  }
}

/** The draft to open, with each field the repository can take, and a line for each it could not. */
export interface FittedDraft {
  readonly draft: IssueDraft;
  readonly skipped: readonly string[];
}

/**
 * `draft` with the `wanted` fields `draft.repo` can take, read from the host before the create: the first wanted type
 * the repository has (a repository a person owns has no types: TYPE-SKIPPED); each label it has, a missing status label
 * made as the push makes it, any other missing label left out (LABEL-SKIPPED); each login that may be assigned there,
 * as the host spells it (ASSIGNEE-SKIPPED otherwise). A read that fails leaves its field out with gh's line: the issue
 * still opens, and the field push, the status push or `issue label` sets the rest later. `types` keeps one types read
 * per repository across a command's creates.
 */
export async function fitIssueFields(host: IssueHost, draft: IssueDraft, wanted: WantedFields, types: RepoTypes = new RepoTypes(host)): Promise<FittedDraft> {
  const skipped: string[] = [];
  const type = await fitType(types, draft.repo, wanted.types, skipped);
  const labels: string[] = [];
  for (const label of wanted.labels) {
    if (await labelFits(host, draft.repo, label, skipped)) {
      labels.push(label);
    }
  }
  const assignees: string[] = [];
  for (const login of wanted.assignees) {
    const read = await host.assigneeExists(draft.repo, login);
    if (read.kind === 'found') {
      assignees.push(read.login);
    } else {
      skipped.push(`ASSIGNEE-SKIPPED ${login} on ${draft.repo}: ${read.kind === 'missing' ? 'may not be assigned there' : read.reason}`);
    }
  }
  return { draft: { ...draft, type, labels: [...draft.labels, ...labels.filter((label) => !draft.labels.includes(label))], assignees }, skipped };
}

/** The first of `wanted` the repository has, as it spells it; null, with a TYPE-SKIPPED line, when it has none of them. */
async function fitType(types: RepoTypes, repo: string, wanted: readonly string[], skipped: string[]): Promise<string | null> {
  const first = wanted[0];
  if (first === undefined) {
    return null;
  }
  const pending = types.of(repo);
  if (pending === undefined) {
    skipped.push(`TYPE-SKIPPED ${first} on ${repo}: the tracker has no issue types; the issue opens with none`);
    return null;
  }
  const read = await pending;
  if (read.kind === 'failed') {
    skipped.push(`TYPE-SKIPPED ${first} on ${repo}: ${read.reason}`);
    return null;
  }
  const named = firstTypeIn(wanted, read.types);
  if (named === undefined) {
    const why = read.types.length === 0 ? 'it has no issue types (only a repository an organisation owns has them)' : `its issue types are ${read.types.join(', ')}`;
    skipped.push(`TYPE-SKIPPED ${wanted.join(' or ')} on ${repo}: ${why}; the issue opens with none`);
    return null;
  }
  return named;
}

/** Whether `label` may go on a new issue of `repo`: it has it, or it is a status label made now. */
async function labelFits(host: IssueHost, repo: string, label: string, skipped: string[]): Promise<boolean> {
  const read = await host.labelExists(repo, label);
  if (read.kind === 'found') {
    return true;
  }
  if (read.kind === 'failed') {
    skipped.push(`LABEL-SKIPPED ${label} on ${repo}: ${read.reason}`);
    return false;
  }
  const spec = managedLabel(label);
  if (spec === undefined) {
    skipped.push(`LABEL-SKIPPED ${label} on ${repo}: the repository has no such label, and teamrig makes only its status and design labels`);
    return false;
  }
  const made = await host.createLabel(repo, spec);
  if (made.kind === 'failed') {
    skipped.push(`LABEL-SKIPPED ${label} on ${repo}: making it failed: ${made.reason}`);
    return false;
  }
  return true;
}
