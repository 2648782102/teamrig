import type { GithubConfig } from '../config/types.ts';
import { acceptorLabelled, issueTrust, trustRules, type TrustRules } from '../github/trust.ts';
import { targetText, type IssueHost, type IssueTarget, type LabelSpec } from './host.ts';
import type { HostIssue } from './issue.ts';
import { managedLabel } from './managed-labels.ts';
import { STATUS_LABELS } from './status-push.ts';

/**
 * What the push's triage (T4326) goes by: whose issues are work, the labels only the maintainers give, and the label
 * an outsider's issue gets in their place.
 */
export interface TriageRules {
  readonly trust: TrustRules;
  /** [github.restrictedLabels], trimmed and in lowercase. */
  readonly restricted: ReadonlySet<string>;
  /** [github.featureLabel] */
  readonly feature: string;
}

/** The triage rules of a team's `github` config, or undefined when `github.restrictedLabels` is empty: no triage. */
export function triageRules(
  github: Pick<GithubConfig, 'acceptLabel' | 'trustedAuthors' | 'acceptors' | 'restrictedLabels' | 'featureLabel'>,
): TriageRules | undefined {
  if (github.restrictedLabels.length === 0) {
    return undefined;
  }
  return { trust: trustRules(github), restricted: new Set(github.restrictedLabels.map(normal)), feature: github.featureLabel };
}

/** One issue's triage: the restricted labels it loses, the labels it gains, and the comment telling its author why. */
export interface TriageStep {
  readonly target: IssueTarget;
  /** As the issue spells them, so the remove names the repository's own label. */
  readonly remove: readonly string[];
  readonly add: readonly string[];
  readonly comment: string | undefined;
}

/** A repository's triage: the steps this run sends, in issue order, and how many wait for the next run's writes. */
export interface TriagePlan {
  readonly repo: string;
  readonly steps: readonly TriageStep[];
  readonly deferred: number;
}

/** The writes a step sends: one per label taken off, one for the labels added, one for the comment. */
export function triageWrites(step: TriageStep): number {
  return step.remove.length + (step.add.length > 0 ? 1 : 0) + (step.comment === undefined ? 0 : 1);
}

/**
 * The triage of `repo`'s open issues: an untrusted author's issue (github/trust.ts issueTrust: neither of a trusted
 * tie nor accepted) that carries a restricted label loses it, as the author (or the issue template, which labels as
 * the author) asked for work only the maintainers give. A restricted label an acceptor put on last stays, and so does
 * one whose last label event is past the timeline window the host read, as who put it on is unknown. When none
 * stays, the issue also gains the feature label and `status:waiting` and gets one comment saying why; when one
 * stays, a maintainer triaged it, so the step only takes the others off. Steps go in issue-number order while
 * `writes` lasts; the rest are counted as deferred, and the next run plans them again from the issues as they are.
 */
export function planTriage(repo: string, issues: readonly HostIssue[], rules: TriageRules, writes: number): TriagePlan {
  const steps: TriageStep[] = [];
  let left = writes;
  let deferred = 0;
  const open = issues.filter((issue) => issue.state === 'open').sort((one, other) => one.number - other.number);
  for (const issue of open) {
    const step = stepOf(issue, rules);
    if (step === undefined) {
      continue;
    }
    const cost = triageWrites(step);
    if (deferred > 0 || cost > left) {
      deferred += 1;
      continue;
    }
    steps.push(step);
    left -= cost;
  }
  return { repo, steps, deferred };
}

/** The triage step of one open issue, or undefined when it needs none. */
function stepOf(issue: HostIssue, rules: TriageRules): TriageStep | undefined {
  if (issueTrust(issue, rules.trust) !== 'untrusted') {
    return undefined;
  }
  const restricted = issue.labels.filter((label) => rules.restricted.has(normal(label)));
  const kept = restricted.filter((label) => !labelEventKnown(issue, label) || acceptorLabelled(issue, label, rules.trust) !== undefined);
  const remove = restricted.filter((label) => !kept.includes(label));
  if (remove.length === 0) {
    return undefined;
  }
  const target = { repo: issue.repo, number: issue.number };
  if (kept.length > 0) {
    return { target, remove, add: [], comment: undefined };
  }
  const has = new Set(issue.labels.map(normal));
  const add = [rules.feature, STATUS_LABELS.waiting].filter((label) => !has.has(normal(label)));
  return { target, remove, add, comment: triageComment(remove, rules) };
}

/** Whether the timeline window the host read holds a label event of `label`. */
function labelEventKnown(issue: HostIssue, label: string): boolean {
  return issue.labelEvents.some((event) => normal(event.label) === normal(label));
}

/** The comment an outsider's relabelled issue gets: what changed, why, and how it is taken on. Names no person. */
export function triageComment(removed: readonly string[], rules: TriageRules): string {
  const names = removed.map((label) => `\`${label}\``).join(' and ');
  return [
    `This issue had ${names}, which the maintainers give to their own work, so it is now \`${rules.feature}\` and waits for triage.`,
    `A maintainer who takes it on adds \`${rules.trust.acceptLabel}\`; nothing else is needed from you.`,
  ].join(' ');
}

/** `<repo>#<n>: -task +feature +status:waiting, a comment`: what a step changes, for its TRIAGE or TRIAGED line. */
export function triageLine(step: TriageStep): string {
  const labels = [...step.remove.map((label) => `-${label}`), ...step.add.map((label) => `+${label}`)].join(' ');
  return `${targetText(step.target)}: ${labels}${step.comment === undefined ? '' : ', a comment'}`;
}

/** What a repository's triage did: the writes it planned, those it sent, the issues it changed, and why it stopped, if it did. */
export interface TriageOutcome {
  readonly planned: number;
  readonly writes: number;
  readonly sent: number;
  readonly failed: string | undefined;
}

/**
 * Prints `plan` and, with `send`, sends it through `host`. Each label a step adds is read once first: one teamrig
 * manages (issues/managed-labels.ts) and the repository lacks is made (a MADE line, a write on top of the plan's);
 * another it lacks holds the steps adding it (a MISSING line). Each step adds its labels, takes the restricted ones
 * off, then comments last: a step that fails part way may lose its comment, as the next run plans none once the
 * labels are off, but never posts it twice. The first failure stops the repository (a FAILED line). Prints nothing for a plan with no step, as the automatic sync
 * runs it every minute.
 */
export async function sendTriage(host: IssueHost, plan: TriagePlan, send: boolean, say: (line: string) => void): Promise<TriageOutcome> {
  if (plan.steps.length === 0 && plan.deferred === 0) {
    return { planned: 0, writes: 0, sent: 0, failed: undefined };
  }
  const planned = plan.steps.reduce((sum, step) => sum + triageWrites(step), 0);
  if (plan.deferred > 0) {
    say(`TRIAGE ${plan.repo}: ${plan.deferred} issue(s) left for the next run's writes`);
  }
  if (!send) {
    plan.steps.forEach((step) => say(`TRIAGE ${triageLine(step)}`));
    return { planned, writes: planned, sent: 0, failed: undefined };
  }
  const missing = new Set<string>();
  const toMake: LabelSpec[] = [];
  for (const label of new Set(plan.steps.flatMap((step) => step.add))) {
    const found = await host.labelExists(plan.repo, label);
    if (found.kind === 'failed') {
      say(`FAILED ${plan.repo}: ${found.reason}; no issue was triaged`);
      return { planned, writes: 0, sent: 0, failed: found.reason };
    }
    const own = managedLabel(label);
    if (found.kind === 'missing' && own !== undefined) {
      toMake.push(own);
    } else if (found.kind === 'missing') {
      missing.add(label);
    }
  }
  let writes = 0;
  for (const label of toMake) {
    const made = await host.createLabel(plan.repo, label);
    if (made.kind === 'failed') {
      say(`FAILED ${plan.repo}: ${made.reason}; no issue was triaged`);
      return { planned, writes, sent: 0, failed: made.reason };
    }
    say(`MADE ${plan.repo}: the label ${JSON.stringify(label.name)}, which the triage sets`);
    writes += 1;
  }
  const held = plan.steps.filter((step) => step.add.some((label) => missing.has(label)));
  for (const label of missing) {
    say(`MISSING ${plan.repo}: no label ${JSON.stringify(label)}; make it there, and the ${held.filter((step) => step.add.includes(label)).length} issue(s) it triages go on the next run`);
  }
  let sent = 0;
  for (const step of plan.steps.filter((one) => !held.includes(one))) {
    const failed = await sendStep(host, step);
    if (failed !== undefined) {
      say(`FAILED ${targetText(step.target)}: ${failed}; the rest of the triage of ${plan.repo} waits for the next run`);
      return { planned, writes, sent, failed };
    }
    say(`TRIAGED ${triageLine(step)}`);
    sent += 1;
    writes += triageWrites(step);
  }
  return { planned, writes, sent, failed: undefined };
}

/** Sends one step: its labels added, each restricted one taken off, then the comment; the reason of the first failure, if any. */
async function sendStep(host: IssueHost, step: TriageStep): Promise<string | undefined> {
  if (step.add.length > 0) {
    const added = await host.addLabels(step.target, step.add);
    if (added.kind === 'failed') {
      return added.reason;
    }
  }
  for (const label of step.remove) {
    const removed = await host.removeLabel(step.target, label);
    if (removed.kind === 'failed') {
      return removed.reason;
    }
  }
  if (step.comment !== undefined) {
    const commented = await host.comment(step.target, step.comment);
    if (commented.kind === 'failed') {
      return commented.reason;
    }
  }
  return undefined;
}

/** GitHub matches label names without case; the config keeps restricted labels trimmed and in lowercase. */
function normal(label: string): string {
  return label.trim().toLowerCase();
}
