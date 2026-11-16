import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { CliHarness, TEAM, TEAM_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { FakeGh, ghIssue, ghPull } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web'], owners: { octocat: 'bravo' } } };
const AS_LEAD: RunOptions = { env: { TEAMRIG_SESSION: 'lead' } };
const AS_ALPHA: RunOptions = { env: { TEAMRIG_SESSION: 'alpha' } };

async function sync(kit: CliHarness, gh: FakeGh, write = true): Promise<void> {
  const result = await kit.run(['issue', 'sync', ...(write ? ['--yes'] : [])], { gh });
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

async function driftRows(kit: CliHarness): Promise<string[]> {
  const result = await kit.run(['check', '--all'], AS_LEAD);
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
  return result.stdout.filter((line) => line.includes('GH-DRIFT'));
}

/** Issue #922's case: a pull request that closes the issue is open, while the issue still shows status:open, unassigned. */
const reviewed = (labels: readonly string[]): FakeGh => new FakeGh().holds('acme/web', [ghIssue('acme/web', 9, { labels, linkedPulls: 1 })]);

describe('check GH-DRIFT (T3205)', () => {
  it('shows the lead an open issue a pull request closes while it shows status:open, until it shows status:in review', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    assert.deepEqual(await driftRows(kit), [], 'no drift file, no row');

    await sync(kit, reviewed(['status:open']));
    const rows = await driftRows(kit);
    assert.equal(rows.length, 1, rows.join('\n'));
    assert.match(rows[0] ?? '', /GH-DRIFT gh:acme\/web#9: an open pull request closes it, yet it shows status:open and no assignee, not status:in review/);

    await sync(kit, reviewed(['status:in review']));
    assert.deepEqual(await driftRows(kit), [], 'set right: the row drops out');
  });

  it('shows an outside pull request no one labelled until it carries a label, and keeps it while its read fails', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    const outside = (labels: number): FakeGh =>
      new FakeGh().holds('acme/web', []).holdsPulls('acme/web', [ghPull('acme/web', 12, { authorAssociation: 'CONTRIBUTOR', author: 'stranger', labels }), ghPull('acme/web', 13)]);
    await sync(kit, outside(0));
    const rows = await driftRows(kit);
    assert.equal(rows.length, 1, rows.join('\n'));
    assert.match(rows[0] ?? '', /GH-DRIFT gh:acme\/web#12: an outside pull request no one labelled/);

    const failing = outside(1).failsPulls('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Bad credentials\n' });
    assert.equal((await kit.run(['issue', 'sync', '--yes'], { gh: failing })).code, EXIT.failed);
    assert.equal((await driftRows(kit)).length, 1, 'a failed pull request read keeps what the last read found');

    await sync(kit, outside(1));
    assert.deepEqual(await driftRows(kit), [], 'labelled: the row drops out');
  });

  it('finds nothing on a preview, which writes no state', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await sync(kit, reviewed(['status:open']), false);
    assert.deepEqual(await driftRows(kit), []);
  });

  it('tells the lead once while it stands', async () => {
    const kit = new CliHarness(GITHUB_TEAM);
    await sync(kit, reviewed(['status:open']));
    const told = async (): Promise<number> => {
      assert.equal((await kit.run(['start'], AS_ALPHA)).code, EXIT.ok);
      const inbox = (await kit.files.read(join(TEAM_HOME, 'state', 'inbox', 'lead.md'))) ?? '';
      return inbox.split('\n').filter((line) => line.includes('GH-DRIFT gh:acme/web#9')).length;
    };
    assert.equal(await told(), 1);
    assert.equal(await told(), 1);
  });
});
