import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { FakePushedStore } from '../testing/fake-pushed-store.ts';
import type { PushedEntry } from './pushed-record.ts';
import { RecordingIssueHost } from './recording-host.ts';

const TARGET = { repo: 'acme/web', number: 7 };
const KEY = 'acme/web#7';
const ENTRY: PushedEntry = { ...TARGET, labels: ['status:open'], assignees: [], at: 1 };

/** A recording host over `inner`, its record holding ENTRY, at time 50. */
function recording(inner: FakeIssueHost = new FakeIssueHost()): { host: RecordingIssueHost; store: FakePushedStore; inner: FakeIssueHost } {
  const store = new FakePushedStore(new Map([[KEY, ENTRY]]));
  return { host: new RecordingIssueHost(inner, store, () => 50), store, inner };
}

describe('RecordingIssueHost (T3230)', () => {
  it("moves the record by each status label and assign write that went, so the push sees teamrig's own write", async () => {
    const { host, store, inner } = recording();
    assert.deepEqual(await host.addLabels(TARGET, ['status:in progress', 'bug']), { kind: 'done' });
    await host.removeLabel(TARGET, 'status:open');
    await host.assign(TARGET, ['OctoCat', 'hubot']);
    await host.unassign(TARGET, 'hubot');
    assert.deepEqual(store.state.get(KEY), { ...TARGET, labels: ['status:in progress'], assignees: ['octocat'], at: 50 });
    assert.deepEqual(
      inner.calls.map((call) => call.kind),
      ['label-add', 'label-remove', 'assign', 'unassign'],
    );
  });

  it('records nothing for a write that failed, or a label outside the status namespace', async () => {
    const { host, store } = recording(new FakeIssueHost().failsLabel('HTTP 422'));
    assert.equal((await host.addLabels(TARGET, ['status:waiting'])).kind, 'failed');
    await host.removeLabel(TARGET, 'bug');
    assert.equal(store.updates, 0);
    assert.deepEqual(store.state.get(KEY), ENTRY);
  });

  it('drops an issue it closed, and keeps none for an issue the record lacks', async () => {
    const { host, store } = recording();
    await host.assign({ repo: 'acme/web', number: 8 }, ['octocat']);
    assert.deepEqual([...store.state.keys()], [KEY]);
    await host.close(TARGET, 'completed');
    assert.equal(store.state.size, 0);
  });

  it('starts the entry of an issue it opened with its status labels, so the first push holds nothing', async () => {
    const { host, store } = recording();
    const opened = await host.open({ repo: 'acme/web', title: 'New', body: 'Work.', labels: ['p2', 'status:open'] });
    assert.equal(opened.kind, 'opened');
    const target = opened.kind === 'opened' ? opened.target : assert.fail('not opened');
    assert.deepEqual(store.state.get(`${target.repo}#${target.number}`), { ...target, labels: ['status:open'], assignees: [], at: 50 });
  });

  it('passes every read through to the host it wraps, under its name', async () => {
    const { host } = recording();
    assert.equal(host.name, new FakeIssueHost().name);
    assert.deepEqual(await host.labelExists('acme/web', 'status:open'), await new FakeIssueHost().labelExists('acme/web', 'status:open'));
  });
});
