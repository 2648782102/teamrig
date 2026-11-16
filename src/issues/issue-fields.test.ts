import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ISSUE_FIELDS } from '../config/defaults.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { testTask } from '../testing/task.ts';
import type { IssueDraft } from './host.ts';
import { fieldsText, fitIssueFields, issueRulesOf, RepoTypes, wantedFields, type IssueRules, type WantedFields } from './issue-fields.ts';

const REPO = 'acme/web';
const RULES: IssueRules = issueRulesOf({ owners: { octocat: 'alpha', 'mona-lisa': 'beta' }, areaOwners: { 'area:cli': 'beta', 'area:sync': 'alpha' }, fields: DEFAULT_ISSUE_FIELDS });
const DRAFT: IssueDraft = { repo: REPO, title: 'Fix login', body: 'Steps', labels: ['bug', 'p0'], type: null, assignees: [] };
const WANTED: WantedFields = { types: ['Bug'], labels: ['status:in progress', 'area:sync'], assignees: ['octocat'] };

describe('wantedFields', () => {
  it("gives a started task its kind's types, its status label, its owner's area label and its owner's login", () => {
    assert.deepEqual(wantedFields(testTask({ status: 'in-progress' }), DRAFT, RULES), { types: ['Task'], labels: ['status:in progress', 'area:sync'], assignees: ['octocat'] });
  });

  it("leaves an open, unplanned task unassigned, and assigns a session with no login to the repository's owner", () => {
    assert.deepEqual(wantedFields(testTask({ owner: 'gamma' }), DRAFT, RULES), { types: ['Task'], labels: ['status:open'], assignees: [] });
    assert.deepEqual(wantedFields(testTask({ owner: 'gamma', status: 'waiting' }), DRAFT, RULES), { types: ['Task'], labels: ['status:waiting'], assignees: ['acme'] });
  });

  it('gives a goal its goal types and no status label, as the push gives none', () => {
    assert.deepEqual(wantedFields(testTask({ owner: 'beta', after: ['T2'], due: '2030-01-02' }), DRAFT, RULES), { types: ['Feature', 'Goal'], labels: ['area:cli'], assignees: ['mona-lisa'] });
  });

  it("types each kind as github.fields.types names it, a design issue by the draft's label, and none while the field push is off (T3349)", () => {
    const rules = issueRulesOf({ owners: {}, areaOwners: {}, fields: { push: true, types: { task: ['Chore', 'Task'], bug: ['Defect'], goal: [], design: ['Design'] } } });
    assert.deepEqual(wantedFields(testTask({ type: 'bug' }), DRAFT, rules).types, ['Defect']);
    assert.deepEqual(wantedFields(testTask(), DRAFT, rules).types, ['Chore', 'Task']);
    assert.deepEqual(wantedFields(testTask({ after: ['T2'] }), DRAFT, rules).types, []);
    assert.deepEqual(wantedFields(testTask(), { ...DRAFT, labels: ['design'] }, rules).types, ['Design']);
    const off = issueRulesOf({ owners: {}, areaOwners: {}, fields: { ...DEFAULT_ISSUE_FIELDS, push: false } });
    assert.deepEqual(wantedFields(testTask({ type: 'bug' }), DRAFT, off).types, []);
  });
});

describe('fieldsText', () => {
  it('says the first type, the labels and who it is assigned to', () => {
    assert.equal(fieldsText(WANTED), 'type Bug, labels status:in progress, area:sync, assigned octocat');
    assert.equal(fieldsText({ types: ['Feature', 'Goal'], labels: [], assignees: [] }), 'type Feature, no status or area label, unassigned');
    assert.equal(fieldsText({ types: [], labels: [], assignees: [] }), 'no type, no status or area label, unassigned');
  });
});

describe('fitIssueFields', () => {
  it('opens with every field the repository has, the type and login as it spells them', async () => {
    const host = new FakeIssueHost().hasIssueTypes('Task', 'bug', 'Feature').hasLabels('status:in progress', 'area:sync').spells('OctoCat');
    const fitted = await fitIssueFields(host, DRAFT, WANTED);
    assert.deepEqual(fitted, { draft: { ...DRAFT, type: 'bug', labels: ['bug', 'p0', 'status:in progress', 'area:sync'], assignees: ['OctoCat'] }, skipped: [] });
    assert.deepEqual(host.calls, []);
    assert.deepEqual(host.typesReads, [REPO]);
  });

  it('takes the first of the wanted types the repository has', async () => {
    const fitted = await fitIssueFields(new FakeIssueHost().hasIssueTypes('Task', 'Goal').hasLabels(...WANTED.labels), DRAFT, { ...WANTED, types: ['Feature', 'Goal'] });
    assert.equal(fitted.draft.type, 'Goal');
    assert.deepEqual(fitted.skipped, []);
  });

  it('reads no types when none is wanted, and says nothing of it', async () => {
    const host = new FakeIssueHost().hasIssueTypes('Bug').hasLabels(...WANTED.labels);
    const fitted = await fitIssueFields(host, DRAFT, { ...WANTED, types: [] });
    assert.equal(fitted.draft.type, null);
    assert.deepEqual(fitted.skipped, []);
    assert.deepEqual(host.typesReads, []);
  });

  it('skips the type on a tracker with no issue types and on a repository with none, saying why, and still opens the rest', async () => {
    const untracked = await fitIssueFields(new FakeIssueHost().hasLabels(...WANTED.labels), DRAFT, WANTED);
    assert.equal(untracked.draft.type, null);
    assert.deepEqual(untracked.draft.assignees, ['octocat']);
    assert.deepEqual(untracked.skipped, ['TYPE-SKIPPED Bug on acme/web: the tracker has no issue types; the issue opens with none']);
    const personal = await fitIssueFields(new FakeIssueHost().hasIssueTypes().hasLabels(...WANTED.labels), DRAFT, WANTED);
    assert.deepEqual(personal.skipped, ['TYPE-SKIPPED Bug on acme/web: it has no issue types (only a repository an organisation owns has them); the issue opens with none']);
  });

  it('names the types a repository has when none of the wanted ones is among them, and a failed read', async () => {
    const other = await fitIssueFields(new FakeIssueHost().hasIssueTypes('Task', 'Epic').hasLabels(...WANTED.labels), DRAFT, { ...WANTED, types: ['Bug', 'Defect'] });
    assert.deepEqual(other.skipped, ['TYPE-SKIPPED Bug or Defect on acme/web: its issue types are Task, Epic; the issue opens with none']);
    const failed = await fitIssueFields(new FakeIssueHost().failsIssueTypes('gh: HTTP 502').hasLabels(...WANTED.labels), DRAFT, WANTED);
    assert.deepEqual(failed.skipped, ['TYPE-SKIPPED Bug on acme/web: gh: HTTP 502']);
  });

  it('reads the types of each repository once across the creates that share a RepoTypes', async () => {
    const host = new FakeIssueHost().hasIssueTypes('Bug').hasLabels(...WANTED.labels);
    const types = new RepoTypes(host);
    await fitIssueFields(host, DRAFT, WANTED, types);
    await fitIssueFields(host, { ...DRAFT, repo: 'ACME/web' }, WANTED, types);
    await fitIssueFields(host, { ...DRAFT, repo: 'acme/api' }, WANTED, types);
    assert.deepEqual(host.typesReads, [REPO, 'acme/api']);
  });

  it('makes a missing status label as the push does, and leaves out a missing area label', async () => {
    const host = new FakeIssueHost().hasIssueTypes('Bug');
    const fitted = await fitIssueFields(host, DRAFT, WANTED);
    assert.deepEqual(fitted.draft.labels, ['bug', 'p0', 'status:in progress']);
    assert.deepEqual(
      host.calls.map((call) => (call.kind === 'label-create' ? call.label.name : call.kind)),
      ['status:in progress'],
    );
    assert.deepEqual(fitted.skipped, ['LABEL-SKIPPED area:sync on acme/web: the repository has no such label, and teamrig makes only its status and design labels']);
  });

  it('leaves out a status label it failed to make, and a label whose read failed', async () => {
    const unmade = await fitIssueFields(new FakeIssueHost().hasIssueTypes('Bug').hasLabels('area:sync').failsLabelCreate('gh: HTTP 403'), DRAFT, WANTED);
    assert.deepEqual(unmade.draft.labels, ['bug', 'p0', 'area:sync']);
    assert.deepEqual(unmade.skipped, ['LABEL-SKIPPED status:in progress on acme/web: making it failed: gh: HTTP 403']);
    const unread = await fitIssueFields(new FakeIssueHost().hasIssueTypes('Bug').failsLabelRead('gh: HTTP 502'), DRAFT, WANTED);
    assert.deepEqual(unread.draft.labels, ['bug', 'p0']);
    assert.equal(unread.skipped.length, 2);
  });

  it('leaves out a login that may not be assigned there, and one whose read failed', async () => {
    const host = new FakeIssueHost().hasIssueTypes('Bug').hasLabels(...WANTED.labels).cannotAssign('octocat');
    const fitted = await fitIssueFields(host, DRAFT, WANTED);
    assert.deepEqual(fitted.draft.assignees, []);
    assert.deepEqual(fitted.skipped, ['ASSIGNEE-SKIPPED octocat on acme/web: may not be assigned there']);
    const failed = await fitIssueFields(new FakeIssueHost().hasIssueTypes('Bug').hasLabels(...WANTED.labels).readsAssignee({ kind: 'failed', reason: 'gh: HTTP 502' }), DRAFT, WANTED);
    assert.deepEqual(failed.skipped, ['ASSIGNEE-SKIPPED octocat on acme/web: gh: HTTP 502']);
  });

  it('adds a wanted label the draft has already only once', async () => {
    const fitted = await fitIssueFields(new FakeIssueHost().hasIssueTypes('Bug').hasLabels(...WANTED.labels), { ...DRAFT, labels: ['area:sync'] }, WANTED);
    assert.deepEqual(fitted.draft.labels, ['area:sync', 'status:in progress']);
  });
});
