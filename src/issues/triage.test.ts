import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_GITHUB } from '../config/defaults.ts';
import type { GithubConfig } from '../config/types.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { testHostIssue } from '../testing/host-issue.ts';
import { FEATURE_LABEL_SPEC } from './feature-label.ts';
import type { HostIssue, LabelEvent } from './issue.ts';
import { planTriage, sendTriage, triageLine, triageRules, triageWrites, type TriagePlan, type TriageRules } from './triage.ts';

const OPENED = '2030-01-02T00:00:00Z';
const LATER = '2030-01-03T00:00:00Z';

function rules(overrides: Partial<GithubConfig> = {}): TriageRules {
  const made = triageRules({ ...DEFAULT_GITHUB, ...overrides });
  assert.ok(made !== undefined);
  return made;
}

function labelled(label: string, actor: string, at = OPENED, actorKind = 'User'): LabelEvent {
  return { label, at, actor, actorKind };
}

/** An outsider's open issue `number`, with `labels`, the template (as the author) having put each on. */
function outsider(number: number, labels: readonly string[], overrides: Partial<HostIssue> = {}): HostIssue {
  return testHostIssue(number, {
    authorAssociation: 'NONE',
    author: 'stranger',
    labels,
    labelEvents: labels.map((label) => labelled(label, 'stranger')),
    ...overrides,
  });
}

function said(): { lines: string[]; say: (line: string) => void } {
  const lines: string[] = [];
  return { lines, say: (line) => lines.push(line) };
}

describe('triageRules (T4326)', () => {
  it('gives none when github.restrictedLabels is empty, else the restricted labels in lowercase and the feature label', () => {
    assert.equal(triageRules({ ...DEFAULT_GITHUB, restrictedLabels: [] }), undefined);
    const made = rules({ restrictedLabels: ['task', 'design'], featureLabel: 'idea' });
    assert.deepEqual([...made.restricted], ['task', 'design']);
    assert.equal(made.feature, 'idea');
  });
});

describe('planTriage (T4326)', () => {
  it('takes a restricted label off an outsider\'s issue, adds the feature and waiting labels, and comments once', () => {
    const plan = planTriage('acme/web', [outsider(7, ['Task', 'bug'])], rules(), 20);
    assert.equal(plan.steps.length, 1);
    const [step] = plan.steps;
    assert.ok(step !== undefined);
    assert.deepEqual(step.remove, ['Task'], 'removed as the issue spells it');
    assert.deepEqual(step.add, ['feature', 'status:waiting']);
    assert.ok(step.comment?.includes('`Task`') === true && step.comment.includes('`feature`') && step.comment.includes('`teamrig`'), step.comment);
    assert.equal(triageWrites(step), 3);
    assert.equal(triageLine(step), 'acme/web#7: -Task +feature +status:waiting, a comment');
  });

  it('adds only the labels the issue lacks', () => {
    const [step] = planTriage('acme/web', [outsider(7, ['design', 'feature'])], rules(), 20).steps;
    assert.deepEqual(step?.add, ['status:waiting']);
  });

  it('leaves a trusted author\'s, an accepted, a closed and an unrestricted issue alone', () => {
    const accepted = outsider(3, ['task', 'teamrig'], { labelEvents: [labelled('task', 'stranger'), labelled('teamrig', 'maintainer', LATER)] });
    const issues = [
      testHostIssue(1, { labels: ['task'], labelEvents: [labelled('task', 'maintainer')] }),
      outsider(2, ['bug']),
      accepted,
      outsider(4, ['task'], { state: 'closed' }),
    ];
    assert.deepEqual(planTriage('acme/web', issues, rules(), 20), { repo: 'acme/web', steps: [], deferred: 0 });
  });

  it('keeps a restricted label an acceptor put on, and then only takes the others off, with no comment', () => {
    const issue = outsider(7, ['task', 'design'], { labelEvents: [labelled('design', 'stranger'), labelled('task', 'maintainer', LATER)] });
    assert.deepEqual(planTriage('acme/web', [issue], rules(), 20).steps, [{ target: { repo: 'acme/web', number: 7 }, remove: ['design'], add: [], comment: undefined }]);
    const onlyTask = outsider(8, ['task'], { labelEvents: [labelled('task', 'maintainer', LATER)] });
    assert.deepEqual(planTriage('acme/web', [onlyTask], rules(), 20).steps, [], 'nothing to take off');
  });

  it('counts a label put on by a person who is not one of github.acceptors, or by a bot, as the author\'s', () => {
    const byMember = outsider(7, ['task'], { labelEvents: [labelled('task', 'member', LATER)] });
    assert.equal(planTriage('acme/web', [byMember], rules({ acceptors: ['lead-person'] }), 20).steps.length, 1);
    const byBot = outsider(8, ['task'], { labelEvents: [labelled('task', 'triage-bot', LATER, 'Bot')] });
    assert.equal(planTriage('acme/web', [byBot], rules(), 20).steps.length, 1);
  });

  it('leaves a restricted label whose label event is past the timeline window, as who put it on is unknown', () => {
    assert.deepEqual(planTriage('acme/web', [outsider(7, ['task'], { labelEvents: [] })], rules(), 20).steps, []);
  });

  it('plans in issue-number order while the writes last, and defers the rest', () => {
    const plan = planTriage('acme/web', [outsider(9, ['task']), outsider(5, ['task']), outsider(7, ['task'])], rules(), 7);
    assert.deepEqual(plan.steps.map((step) => step.target.number), [5, 7]);
    assert.equal(plan.deferred, 1);
    assert.equal(planTriage('acme/web', [outsider(5, ['task'])], rules(), 2).deferred, 1, 'a step past the writes waits whole');
  });
});

describe('sendTriage (T4326)', () => {
  const plan = (): TriagePlan => planTriage('acme/web', [outsider(7, ['task'])], rules(), 20);

  it('prints nothing and writes nothing for a plan with no step', async () => {
    const host = new FakeIssueHost();
    const out = said();
    assert.deepEqual(await sendTriage(host, { repo: 'acme/web', steps: [], deferred: 0 }, true, out.say), { planned: 0, writes: 0, sent: 0, failed: undefined });
    assert.deepEqual(out.lines, []);
    assert.deepEqual(host.calls, []);
  });

  it('without send, prints each step and the deferred count and writes nothing', async () => {
    const host = new FakeIssueHost();
    const out = said();
    const outcome = await sendTriage(host, { ...plan(), deferred: 2 }, false, out.say);
    assert.deepEqual(outcome, { planned: 3, writes: 3, sent: 0, failed: undefined });
    assert.deepEqual(out.lines, ["TRIAGE acme/web: 2 issue(s) left for the next run's writes", 'TRIAGE acme/web#7: -task +feature +status:waiting, a comment']);
    assert.deepEqual(host.calls, []);
  });

  it('makes a missing managed label, then adds, removes and comments last', async () => {
    const host = new FakeIssueHost().hasLabels('status:waiting');
    const out = said();
    const outcome = await sendTriage(host, plan(), true, out.say);
    assert.deepEqual(outcome, { planned: 3, writes: 4, sent: 1, failed: undefined });
    const target = { repo: 'acme/web', number: 7 };
    assert.deepEqual(host.calls.slice(0, 3), [
      { kind: 'label-create', repo: 'acme/web', label: FEATURE_LABEL_SPEC },
      { kind: 'label-add', target, labels: ['feature', 'status:waiting'] },
      { kind: 'label-remove', target, label: 'task' },
    ]);
    assert.equal(host.calls[3]?.kind, 'comment');
    assert.equal(host.calls.length, 4);
    assert.deepEqual(out.lines, ['MADE acme/web: the label "feature", which the triage sets', 'TRIAGED acme/web#7: -task +feature +status:waiting, a comment']);
  });

  it('holds the steps adding a missing label teamrig does not manage', async () => {
    const custom = planTriage('acme/web', [outsider(7, ['task'])], rules({ featureLabel: 'idea' }), 20);
    const host = new FakeIssueHost().hasLabels('status:waiting');
    const out = said();
    assert.deepEqual(await sendTriage(host, custom, true, out.say), { planned: 3, writes: 0, sent: 0, failed: undefined });
    assert.deepEqual(out.lines, ['MISSING acme/web: no label "idea"; make it there, and the 1 issue(s) it triages go on the next run']);
    assert.deepEqual(host.calls, []);
  });

  it('stops at a failed label read, label make or write, sending nothing after it', async () => {
    const unread = said();
    const reading = await sendTriage(new FakeIssueHost().failsLabelRead('rate limited'), plan(), true, unread.say);
    assert.equal(reading.failed, 'rate limited');
    assert.deepEqual(unread.lines, ['FAILED acme/web: rate limited; no issue was triaged']);

    const unmade = await sendTriage(new FakeIssueHost().failsLabelCreate('forbidden'), plan(), true, said().say);
    assert.deepEqual(unmade, { planned: 3, writes: 0, sent: 0, failed: 'forbidden' });

    const host = new FakeIssueHost().hasLabels('feature', 'status:waiting').failsRemove('task', 'gone');
    const out = said();
    assert.deepEqual(await sendTriage(host, plan(), true, out.say), { planned: 3, writes: 0, sent: 0, failed: 'gone' });
    assert.ok(!host.calls.some((call) => call.kind === 'comment'), 'no comment after a failed remove');
    assert.deepEqual(out.lines, ['FAILED acme/web#7: gone; the rest of the triage of acme/web waits for the next run']);

    const silent = new FakeIssueHost().hasLabels('feature', 'status:waiting').failsComment('locked');
    assert.equal((await sendTriage(silent, plan(), true, said().say)).failed, 'locked');
  });
});
