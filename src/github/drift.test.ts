import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testHostIssue } from '../testing/host-issue.ts';
import { driftKey, driftText, formatDrift, issueDrift, parseDrift, stepDrift, type Drift } from './drift.ts';

const row = (overrides: Partial<Drift> = {}): Drift => ({ repo: 'acme/web', ref: 'gh:acme/web#9', kind: 'linked-pull', shown: ['status:open'], assigned: false, ...overrides });

describe('issueDrift (T3205)', () => {
  it('flags the #922 case: an open pull request closes it while it shows status:open and no one is assigned', () => {
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 1, labels: ['bug', 'status:open'] })), [row()]);
  });

  it('flags one with no status label, and keeps whether it is assigned', () => {
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 2, assignees: ['octocat'] })), [row({ shown: [], assigned: true })]);
  });

  it('leaves out one showing status:in review in any case, one no pull request closes, and a closed one', () => {
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 1, labels: ['Status:In Review'] })), []);
    assert.deepEqual(issueDrift(testHostIssue(9, { labels: ['status:open'] })), []);
    assert.deepEqual(issueDrift(testHostIssue(9, { linkedPulls: 1, state: 'closed' })), []);
  });
});

describe('stepDrift', () => {
  it('replaces the rows of each repository read and keeps those of one not read', () => {
    const other = row({ repo: 'acme/api', ref: 'gh:acme/api#3' });
    const fixed = row();
    const fresh = row({ ref: 'gh:acme/web#4' });
    assert.deepEqual(stepDrift([other, fixed], new Set(['acme/web']), [fresh, row({ repo: 'acme/api', ref: 'gh:acme/api#8' })]), [other, fresh]);
  });
});

describe('the drift file', () => {
  it('reads back what it writes, and reads a damaged row, file or another format as none', () => {
    const rows = [row(), row({ ref: 'gh:acme/web#4', shown: [], assigned: true })];
    assert.deepEqual(parseDrift(formatDrift(rows)), rows);
    assert.deepEqual(parseDrift('{"v":1,"drift":[{"repo":"acme/web","ref":"gh:acme/web#9","kind":"other","shown":[],"assigned":false}]}'), []);
    assert.deepEqual(parseDrift('{"v":2,"drift":[]}'), []);
    assert.deepEqual(parseDrift('not json'), []);
  });
});

describe('the GH-DRIFT line', () => {
  it('names the thread, what it shows and the fix, keyed by thread and kind', () => {
    assert.equal(driftKey(row()), 'gh-drift gh:acme/web#9 linked-pull');
    assert.equal(
      driftText(row()),
      "GH-DRIFT gh:acme/web#9: an open pull request closes it, yet it shows status:open and no assignee, not status:in review: have its task's owner set it verifying, or the pull request's author unlink it",
    );
    assert.match(driftText(row({ shown: [], assigned: true })), /yet it shows no status label, not status:in review/);
  });
});
