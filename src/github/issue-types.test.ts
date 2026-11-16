import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { typeNamesIn } from './issue-types.ts';

function answer(issueTypes: unknown): string {
  return JSON.stringify({ data: { repository: { issueTypes } } });
}

describe('typeNamesIn', () => {
  it('names the turned-on types, in the order GitHub gives them', () => {
    const nodes = [{ name: 'Task', isEnabled: true }, { name: 'Epic', isEnabled: false }, { name: 'Bug', isEnabled: true }];
    assert.deepEqual(typeNamesIn(answer({ nodes })), ['Task', 'Bug']);
  });

  it('names none for a repository with no types, as one a person owns has', () => {
    assert.deepEqual(typeNamesIn(answer(null)), []);
    assert.deepEqual(typeNamesIn(answer({ nodes: [] })), []);
  });

  it('skips a node of another shape', () => {
    assert.deepEqual(typeNamesIn(answer({ nodes: [{ name: 7, isEnabled: true }, { name: 'Bug' }, 'Task', { name: 'Feature', isEnabled: true }] })), ['Feature']);
  });

  it('gives undefined for output that is not the answer: no JSON, no repository, no nodes list', () => {
    for (const stdout of ['', 'not json', '{"data":{}}', '{"data":{"repository":null}}', answer({ nodes: 'Task' }), '[]']) {
      assert.equal(typeNamesIn(stdout), undefined, stdout);
    }
  });
});
