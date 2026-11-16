import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { afterWrite, fieldsOf, formatPushed, heldFields, parsePushed, withEntry, withoutEntry, PUSHED_FORMAT, type PushedEntry } from './pushed-record.ts';

const TARGET = { repo: 'acme/web', number: 7 };
const ENTRY: PushedEntry = { ...TARGET, labels: ['status:in-progress'], assignees: ['octocat'], at: 1000 };

describe('the pushed record', () => {
  it('reads back what it formats, issues in order, logins in lower case and fields sorted', () => {
    const other: PushedEntry = { repo: 'acme/api', number: 3, labels: [], assignees: [], at: 2000 };
    const text = formatPushed(withEntry(withEntry(new Map(), ENTRY), other));
    assert.equal(text, `{"v":${PUSHED_FORMAT},"issues":[{"repo":"acme/api","number":3,"labels":[],"assignees":[],"at":2000},{"repo":"acme/web","number":7,"labels":["status:in-progress"],"assignees":["octocat"],"at":1000}]}
`);
    assert.deepEqual([...parsePushed(text).values()], [other, ENTRY]);
    const mixed = parsePushed(`{"v":${PUSHED_FORMAT},"issues":[{"repo":"acme/web","number":7,"labels":["status:waiting","status:claimed"],"assignees":["OctoCat","octocat"],"at":5}]}`);
    assert.deepEqual(mixed.get('acme/web#7'), { ...TARGET, labels: ['status:claimed', 'status:waiting'], assignees: ['octocat'], at: 5 });
  });

  it('reads an empty, broken or other-format file as empty, and skips a bad entry', () => {
    assert.equal(parsePushed('').size, 0);
    assert.equal(parsePushed('{not json').size, 0);
    assert.equal(parsePushed(`{"v":${PUSHED_FORMAT + 1},"issues":[${JSON.stringify(ENTRY)}]}`).size, 0);
    const bad = [{ ...ENTRY, number: 0 }, { ...ENTRY, repo: '' }, { ...ENTRY, labels: 'status:open' }, { ...ENTRY, at: 'now' }, 'acme/web#7'];
    assert.equal(parsePushed(`{"v":${PUSHED_FORMAT},"issues":${JSON.stringify(bad)}}`).size, 0);
  });

  it('holds nothing of an issue with no entry, and only the field a person changed of one with an entry', () => {
    const now = fieldsOf(['status:in-progress'], ['OctoCat']);
    assert.deepEqual(heldFields(undefined, now), { labels: false, assignees: false });
    assert.deepEqual(heldFields(ENTRY, now), { labels: false, assignees: false });
    assert.deepEqual(heldFields(ENTRY, fieldsOf(['status:waiting'], ['octocat'])), { labels: true, assignees: false });
    assert.deepEqual(heldFields(ENTRY, fieldsOf(['status:in-progress'], [])), { labels: false, assignees: true });
  });

  it('moves an entry by each teamrig write, and keeps no entry for an issue it had none of', () => {
    let state = withEntry(new Map(), ENTRY);
    state = afterWrite(state, TARGET, { kind: 'add-labels', labels: ['status:waiting'] }, 2000);
    state = afterWrite(state, TARGET, { kind: 'remove-label', label: 'status:in-progress' }, 2001);
    state = afterWrite(state, TARGET, { kind: 'assign', logins: ['Hubot'] }, 2002);
    state = afterWrite(state, TARGET, { kind: 'unassign', login: 'OctoCat' }, 2003);
    assert.deepEqual(state.get('acme/web#7'), { ...TARGET, labels: ['status:waiting'], assignees: ['hubot'], at: 2003 });
    const none = new Map<string, PushedEntry>();
    assert.equal(afterWrite(none, TARGET, { kind: 'assign', logins: ['hubot'] }, 1), none);
  });

  it('drops an issue the push closed', () => {
    assert.equal(withoutEntry(withEntry(new Map(), ENTRY), TARGET).size, 0);
    const none = new Map<string, PushedEntry>();
    assert.equal(withoutEntry(none, TARGET), none);
  });
});
