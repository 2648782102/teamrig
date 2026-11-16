import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testTask } from '../testing/task.ts';
import { offGitHubReason } from './off-github.ts';

const REVIEWER = 'security';

describe('offGitHubReason (T3349)', () => {
  it('lets a plain task, a plain bug and a critical task that is no bug go by their wording', () => {
    for (const task of [testTask(), testTask({ type: 'bug' }), testTask({ type: 'task', critical: true }), testTask({ ref: 'notes/plan.md' })]) {
      assert.equal(offGitHubReason(task, REVIEWER), undefined);
    }
  });

  it('keeps a task with a local ref, a critical bug and a task the security reviewer owns off GitHub', () => {
    assert.match(offGitHubReason(testTask({ ref: 'local: names a host' }), REVIEWER) ?? '', /^its ref keeps it local; clear that ref first \(update --ref none\)/u);
    assert.equal(offGitHubReason(testTask({ type: 'bug', critical: true }), REVIEWER), 'it is a critical bug, whose issue could tell a security hole');
    assert.equal(offGitHubReason(testTask({ owner: REVIEWER }), REVIEWER), 'the security reviewer (security) owns it');
  });

  it('names no reviewer when the team has none, and never takes another session for one', () => {
    assert.equal(offGitHubReason(testTask({ owner: REVIEWER }), undefined), undefined);
    assert.equal(offGitHubReason(testTask({ owner: 'securityx' }), REVIEWER), undefined);
  });
});
