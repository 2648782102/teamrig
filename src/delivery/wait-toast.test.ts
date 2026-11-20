import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WaitToastConfig } from '../config/types.ts';
import { FileLock } from '../core/lock.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { waitToastDue, waitToastLockPath, waitToastPath, WaitToastStore } from './wait-toast.ts';

const MINUTE = 60_000;
const CONFIG: WaitToastConfig = { afterMinutes: 10, everyMinutes: 15 };
const LOCK = '/kit/host.lock';
const TOAST = waitToastPath(LOCK);

describe('waitToastDue (T4594)', () => {
  it('waits afterMinutes before the first toast', () => {
    assert.equal(waitToastDue(10 * MINUTE - 1, undefined, CONFIG), false);
    assert.equal(waitToastDue(10 * MINUTE, undefined, CONFIG), true);
  });

  it('repeats each everyMinutes after the host last showed one', () => {
    assert.equal(waitToastDue(40 * MINUTE, 15 * MINUTE - 1, CONFIG), false);
    assert.equal(waitToastDue(40 * MINUTE, 15 * MINUTE, CONFIG), true);
  });

  it('holds back a step that waited long enough while another step showed one lately', () => {
    assert.equal(waitToastDue(12 * MINUTE, 2 * MINUTE, CONFIG), false);
  });

  it('shows none with everyMinutes 0, however long the step waited', () => {
    assert.equal(waitToastDue(24 * 60 * MINUTE, undefined, { afterMinutes: 1, everyMinutes: 0 }), false);
  });

  it('counts a last toast stamped in the future, a clock set back, as none', () => {
    assert.equal(waitToastDue(10 * MINUTE, -5 * MINUTE, CONFIG), true);
  });
});

describe('WaitToastStore (T4594)', () => {
  it('keeps its file and its lock beside the host lock', () => {
    assert.deepEqual([waitToastPath(LOCK), waitToastLockPath(LOCK)], ['/kit/host.lock.toast', '/kit/host.lock.toast.lock']);
  });

  it('claims the first toast once the step waited afterMinutes, and writes when', async () => {
    const files = new MemoryFiles();
    const store = new WaitToastStore(files, TOAST, new InlineMutex());
    assert.equal(await store.claim(9 * MINUTE, 0, CONFIG), false);
    assert.equal(await store.claim(10 * MINUTE, 0, CONFIG), true);
    assert.deepEqual(await store.read(), { at: 10 * MINUTE });
  });

  it('claims again only everyMinutes later, whichever step asks', async () => {
    const store = new WaitToastStore(new MemoryFiles(), TOAST, new InlineMutex());
    assert.equal(await store.claim(10 * MINUTE, 0, CONFIG), true);
    assert.equal(await store.claim(20 * MINUTE, 5 * MINUTE, CONFIG), false);
    assert.equal(await store.claim(25 * MINUTE, 5 * MINUTE, CONFIG), true);
  });

  it('claims none and takes no lock while the toast is off or the step is new', async () => {
    const files = new MemoryFiles();
    const mutex = new InlineMutex();
    const store = new WaitToastStore(files, TOAST, mutex);
    assert.equal(await store.claim(60 * MINUTE, 0, { afterMinutes: 10, everyMinutes: 0 }), false);
    assert.equal(await store.claim(5 * MINUTE, 0, CONFIG), false);
    assert.deepEqual([mutex.runs, files.get(TOAST)], [0, undefined]);
  });

  it('reads a damaged file as no toast yet', async () => {
    for (const text of ['{', '{"at":"soon"}', '[]', 'null']) {
      const store = new WaitToastStore(new MemoryFiles({ [TOAST]: text }), TOAST, new InlineMutex());
      assert.equal(await store.read(), undefined, text);
      assert.equal(await store.claim(10 * MINUTE, 0, CONFIG), true, text);
    }
  });

  it('gives one toast to many steps that poll at once, under the file lock', async () => {
    const clock = new FakeClock(30 * MINUTE);
    let takings = 0;
    const files = new MemoryFiles({}, clock);
    const lockOf = (pid: number): FileLock =>
      new FileLock(waitToastLockPath(LOCK), { ttlMs: MINUTE, pollMs: 10, waitMs: MINUTE }, { files, clock, sleep: async () => {}, pid, alive: () => true, newId: () => `id-${pid}-${(takings += 1)}` });
    const steps = [1, 2, 3, 4, 5].map((pid) => new WaitToastStore(files, TOAST, lockOf(pid)));
    const claims = await Promise.all(steps.map((store) => store.claim(clock.now(), 0, CONFIG)));
    assert.equal(claims.filter(Boolean).length, 1, JSON.stringify(claims));
    assert.equal(files.get(waitToastLockPath(LOCK)), undefined);
  });
});
