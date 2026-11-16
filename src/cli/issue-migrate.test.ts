import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { withStampFooter } from '../core/stamp.ts';
import { isIssueCreate, isIssueQuery, isLabelCreate, isLabelRead } from '../github/gh.ts';
import { foldEvents, type Task } from '../register/fold.ts';
import { readEvents } from '../register/snapshot.ts';
import { APP, CliHarness, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FakeCredentials } from '../testing/fake-credentials.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { EXIT } from './runtime.ts';

const GITHUB_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'] } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
const ROWS = join(APP, 'rows.jsonl');
const PREVIEW = join(APP, 'preview.md');
const NO_TOKEN = 'ACCESS acme: opens issues with the token saved as teamrig-gh-acme';
const NO_TYPES = 'it has no issue types (only a repository an organisation owns has them); the issue opens with none';
/** The status label an open task's issue gets, made where the repository lacks it. */
const OPEN_LABEL = ['-f', 'labels[]=status:open'];

function createsOf(gh: FakeGh): readonly (readonly string[])[] {
  return gh.ran.map((request) => request.args).filter(isIssueCreate);
}

function issueRow(id: string, repo: string, title: string, overrides: JsonRecord = {}): string {
  return JSON.stringify({ id, decision: 'issue', repo, type: 'task', priority: 'p2', title, body: `Why ${title}.`, ...overrides });
}

/** A team with three open tasks, T1 to T3, and rows opening T1 in acme/web, T2 in acme/api as a p1 bug, keeping T3 local. */
async function migratingTeam(): Promise<CliHarness> {
  const kit = new CliHarness(GITHUB_TEAM);
  for (const title of ['Private health check', 'Private login bug', 'Private host move']) {
    const added = await kit.run(['add', '--title', title, '--description', 'private what and why', '--priority', 'p2', '--owner', 'alpha'], AS_LEAD);
    assert.equal(added.code, EXIT.ok, [...added.stdout, ...added.stderr].join('\n'));
  }
  await kit.files.write(
    ROWS,
    [issueRow('T1', 'acme/web', 'Add a health check'), issueRow('T2', 'Acme/API', 'Login fails on retry', { type: 'bug', priority: 'p1' }), JSON.stringify({ id: 'T3', decision: 'local', reason: 'Names a host.' }), ''].join('\n'),
  );
  return kit;
}

function tasksOf(kit: CliHarness): ReadonlyMap<string, Task> {
  return foldEvents(readEvents(kit.files.get(EVENTS_PATH) ?? '').events).tasks;
}

async function expectRun(kit: CliHarness, argv: readonly string[], gh: FakeGh, code: number, options: { readonly credentials?: FakeCredentials } = {}): Promise<string[]> {
  const result = await kit.run(argv, { ...AS_LEAD, gh, ...options });
  assert.equal(result.code, code, [...result.stdout, ...result.stderr].join('\n'));
  return [...result.stdout];
}

describe('teamrig issue migrate', () => {
  it('previews the move and writes nothing but the preview file', async () => {
    const kit = await migratingTeam();
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    assert.deepEqual(await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--out', 'preview.md'], gh, EXIT.ok), [
      `PREVIEW FILE ${PREVIEW}`,
      '2 issue(s) to open, 1 kept local, 0 skipped, 0 live task(s) with no row',
      "PREVIEW nothing was written; teamrig issue migrate <file> --yes opens the issues and sets each task's ref",
    ]);
    assert.deepEqual(gh.ran, []);
    assert.equal(kit.files.get(EVENTS_PATH), log);
    const preview = kit.files.get(PREVIEW) ?? '';
    assert.match(preview, /### T1 → acme\/web \[enhancement, p2\]\n\nOpens with type Task, labels status:open, unassigned, each one the repository has\.\n\n\*\*Add a health check\*\*\n\nWhy Add a health check\./u);
    assert.match(preview, /### T2 → acme\/api \[bug, p1\]\n\nOpens with type Bug, /u);
    assert.match(preview, /- T3: Names a host\./u);
    assert.doesNotMatch(preview, /Private/u);
  });

  it('previews one task\'s issue with no row file, naming no other task (T3349)', async () => {
    const kit = await migratingTeam();
    const log = kit.files.get(EVENTS_PATH);
    const gh = new FakeGh();
    assert.deepEqual(await expectRun(kit, ['issue', 'migrate', '--task', 'T2', '--issue', 'Login fails on retry', '--issue-body', 'Retries stop at three.', '--issue-repo', 'acme/api'], gh, EXIT.ok), [
      '1 issue(s) to open, 0 kept local, 0 skipped, 0 live task(s) with no row',
      "PREVIEW nothing was written; the same command with --yes opens the issue and sets T2's ref",
    ]);
    assert.deepEqual(gh.ran, []);
    assert.equal(kit.files.get(EVENTS_PATH), log);
  });

  it('opens one task\'s issue with its own kind of work and priority, and sets its ref (T3349)', async () => {
    const kit = new CliHarness({ ...GITHUB_TEAM, github: { repos: ['acme/web', 'acme/api'], issueAtAdd: 'acme/api' } });
    const added = await kit.run(['add', '--title', 'Private retry fix', '--description', 'private what and why', '--priority', 'p0', '--owner', 'alpha', '--type', 'bug', '--local', 'its issue opens later'], AS_LEAD);
    assert.equal(added.code, EXIT.ok, [...added.stdout, ...added.stderr].join('\n'));
    const gh = new FakeGh();
    const lines = await expectRun(kit, ['issue', 'migrate', '--task', 'T1', '--issue', 'Login fails on retry', '--issue-body', 'Retries stop at three.', '--yes'], gh, EXIT.ok);
    assert.deepEqual(lines.slice(-2), ['OPENED T1 gh:acme/api#1', "DONE opened 1 issue(s) and set each task's ref"]);
    assert.deepEqual(createsOf(gh), [
      ['api', 'repos/acme/api/issues', '-X', 'POST', '-f', 'title=Login fails on retry', '-f', `body=${withStampFooter('Retries stop at three.')}`, '-f', 'labels[]=bug', '-f', 'labels[]=p0', ...OPEN_LABEL],
    ]);
    assert.equal(tasksOf(kit).get('T1')?.ref, 'gh:acme/api#1');
  });

  it('refuses a one-task run without its wording, with a file, or for no such task, opening nothing (T3349)', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    const refusal = async (argv: readonly string[], code: number): Promise<string> => {
      const result = await kit.run(argv, { ...AS_LEAD, gh });
      assert.equal(result.code, code, [...result.stdout, ...result.stderr].join('\n'));
      return [...result.stdout, ...result.stderr].join('\n');
    };
    assert.match(await refusal(['issue', 'migrate', '--task', 'T2', '--issue', 'Login fails on retry', '--yes'], EXIT.usage), /--task takes --issue <title> and --issue-body <text>/u);
    assert.match(await refusal([...['issue', 'migrate', '--task', 'T2', '--issue', 'Login fails on retry', '--issue-body', 'Retries stop at three.', '--issue-repo', 'acme/api'], 'rows.jsonl'], EXIT.usage), /unexpected "rows\.jsonl"/u);
    assert.match(await refusal(['issue', 'migrate', 'rows.jsonl', '--issue', 'Login fails on retry'], EXIT.usage), /go with --task <id>/u);
    assert.match(await refusal(['issue', 'migrate', '--task', 'T9', '--issue', 'Gone', '--issue-body', 'Why.'], EXIT.refused), /no task T9 in the working set/u);
    assert.match(await refusal(['issue', 'migrate', '--task', 'T2', '--issue', 'Gone', '--issue-body', 'Why.'], EXIT.refused), /--issue-repo names the repository/u);
    assert.match(await refusal(['issue', 'migrate', '--task', 'T2', '--issue', 'Gone', '--issue-body', 'Follows T1.', '--issue-repo', 'acme/api'], EXIT.refused), /T1/u);
    assert.deepEqual(gh.ran, []);
  });

  it('names the live tasks no row covers and the rows it skips', async () => {
    const kit = await migratingTeam();
    await kit.files.write(ROWS, [issueRow('T1', 'acme/other', 'Add a health check'), issueRow('T9', 'acme/web', 'Gone')].join('\n'));
    assert.deepEqual(await expectRun(kit, ['issue', 'migrate', ROWS], new FakeGh(), EXIT.ok), [
      'SKIPPED T1: acme/other is not one of github.repos (acme/web, acme/api)',
      'SKIPPED T9: no such task in the working set',
      'NO ROW 2 live task(s) no row names: T2 T3',
      '0 issue(s) to open, 0 kept local, 2 skipped, 2 live task(s) with no row',
      "PREVIEW nothing was written; teamrig issue migrate <file> --yes opens the issues and sets each task's ref",
    ]);
  });

  it('opens each issue, points its task at it, and a rerun and a sync add nothing', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []);
    assert.deepEqual(await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok), [
      '2 issue(s) to open, 1 kept local, 0 skipped, 0 live task(s) with no row',
      NO_TOKEN,
      `TYPE-SKIPPED Task on acme/web: ${NO_TYPES}`,
      'OPENED T1 gh:acme/web#1',
      `TYPE-SKIPPED Bug on acme/api: ${NO_TYPES}`,
      'OPENED T2 gh:acme/api#1',
      "DONE opened 2 issue(s) and set each task's ref",
    ]);
    assert.deepEqual(createsOf(gh), [
      ['api', 'repos/acme/web/issues', '-X', 'POST', '-f', 'title=Add a health check', '-f', `body=${withStampFooter('Why Add a health check.')}`, '-f', 'labels[]=enhancement', '-f', 'labels[]=p2', ...OPEN_LABEL],
      ['api', 'repos/acme/api/issues', '-X', 'POST', '-f', 'title=Login fails on retry', '-f', `body=${withStampFooter('Why Login fails on retry.')}`, '-f', 'labels[]=bug', '-f', 'labels[]=p1', ...OPEN_LABEL],
    ]);
    const migrated = gh.ran.length;
    const tasks = tasksOf(kit);
    assert.deepEqual([...tasks.values()].map((task) => [task.id, task.ref, task.title, task.status]), [
      ['T1', 'gh:acme/web#1', 'Private health check', 'open'],
      ['T2', 'gh:acme/api#1', 'Private login bug', 'open'],
      ['T3', null, 'Private host move', 'open'],
    ]);

    const rerun = new FakeGh();
    assert.deepEqual(await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], rerun, EXIT.ok), [
      'SKIPPED T1: the task has its issue already: gh:acme/web#1',
      'SKIPPED T2: the task has its issue already: gh:acme/api#1',
      '0 issue(s) to open, 1 kept local, 2 skipped, 0 live task(s) with no row',
      "DONE opened 0 issue(s) and set each task's ref",
    ]);
    assert.deepEqual(rerun.ran, []);

    const synced = await kit.run(['issue', 'sync', '--yes'], { ...AS_LEAD, gh });
    assert.equal(synced.code, EXIT.ok, synced.stdout.join('\n'));
    assert.ok(gh.ran.slice(migrated).every((request) => isIssueQuery(request.args)));
    assert.equal(tasksOf(kit).size, 3, synced.stdout.join('\n'));
  });

  it("replaces a task's note ref with its issue, naming the old ref in the preview and the task's history", async () => {
    const kit = await migratingTeam();
    const noted = await kit.run(['update', 'T1', '--ref', 'notes/plan.md'], { env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(noted.code, EXIT.ok, noted.stdout.join('\n'));
    const replaces = 'REPLACES T1: its ref notes/plan.md gives way to its issue';
    assert.equal((await expectRun(kit, ['issue', 'migrate', 'rows.jsonl'], new FakeGh(), EXIT.ok))[0], replaces);
    const lines = await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], new FakeGh(), EXIT.ok);
    assert.deepEqual(lines.slice(0, 2), [replaces, '2 issue(s) to open, 1 kept local, 0 skipped, 0 live task(s) with no row']);
    assert.equal(tasksOf(kit).get('T1')?.ref, 'gh:acme/web#1');
    assert.ok((kit.files.get(EVENTS_PATH) ?? '').includes('ref was: notes/plan.md'));
  });

  it('stops, opening nothing through the gh login, when the store holds the key but cannot read it', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    const credentials = new FakeCredentials().failsOn('teamrig-gh-acme', 'the keyring is locked');
    const lines = await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.failed, { credentials });
    assert.deepEqual(lines.slice(1), [
      'FAILED T1: could not read teamrig-gh-acme from the test store: the keyring is locked; unlock the store and rerun, or save the key again with: save teamrig-gh-acme',
      'STOPPED at T1 after opening 0 issue(s); fix the cause and rerun: tasks holding their issue are skipped',
    ]);
    assert.deepEqual(gh.ran, []);
    assert.ok([...tasksOf(kit).values()].every((task) => task.ref === null));
  });

  it('opens with the token saved for the owner', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    const credentials = new FakeCredentials().saves('teamrig-gh-acme', 'acme-issues-token');
    const lines = await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok, { credentials });
    assert.equal(lines[1], 'ACCESS acme: opens issues with the token saved as teamrig-gh-acme');
    assert.ok(gh.ran.length > 2 && gh.ran.every((request) => request.env['GH_TOKEN'] === 'acme-issues-token'));
    assert.ok(!lines.join('\n').includes('acme-issues-token'));
  });

  it('stops at the first issue gh fails to open, and a rerun opens the rest', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh().failsCreate('acme/web', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' });
    assert.deepEqual((await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.failed)).slice(3), [
      'FAILED T1: gh api for an issue of acme/web exited with code 1: gh: Resource not accessible by integration (HTTP 403)',
      'STOPPED at T1 after opening 0 issue(s); fix the cause and rerun: tasks holding their issue are skipped',
    ]);
    assert.equal(createsOf(gh).length, 1);
    assert.ok([...tasksOf(kit).values()].every((task) => task.ref === null));

    const fixed = new FakeGh();
    const rerun = await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], fixed, EXIT.ok);
    assert.deepEqual(rerun.filter((line) => !line.startsWith('TYPE-SKIPPED')).slice(2), ['OPENED T1 gh:acme/web#1', 'OPENED T2 gh:acme/api#1', "DONE opened 2 issue(s) and set each task's ref"]);
  });

  it('says to look on GitHub when gh printed no issue number', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh().failsCreate('acme/web', { end: { kind: 'exited', code: 0 }, stdout: 'created', stderr: '' });
    const lines = await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.failed);
    assert.equal(lines[3], "FAILED T1: gh printed no issue number: look for it on acme/web before a rerun, and set the task's ref if it is there");
  });

  it('runs gh for issue creates, the reads the fit makes and status labels only', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok);
    assert.equal(createsOf(gh).length, 2);
    assert.ok(gh.ran.every((request) => [isIssueCreate, isIssueQuery, isLabelRead, isLabelCreate].some((allowed) => allowed(request.args))));
  });

  it('opens a started task\'s issue with its type, status and area labels and its owner\'s login (T3349)', async () => {
    const kit = new CliHarness({ ...GITHUB_TEAM, github: { repos: ['acme/web'], owners: { octocat: 'alpha' }, areaOwners: { 'area:sync': 'alpha' } } });
    const added = await kit.run(['add', '--title', 'Private retry fix', '--description', 'private what and why', '--priority', 'p0', '--owner', 'alpha', '--type', 'bug'], AS_LEAD);
    assert.equal(added.code, EXIT.ok, [...added.stdout, ...added.stderr].join('\n'));
    const started = await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
    assert.equal(started.code, EXIT.ok, [...started.stdout, ...started.stderr].join('\n'));
    await kit.files.write(ROWS, issueRow('T1', 'acme/web', 'Retry fails', { type: 'bug', priority: 'p0' }));
    const gh = new FakeGh().holds('acme/web', []).holdsFields('acme/web', { fields: [], types: [{ name: 'Task', isEnabled: true }, { name: 'Bug', isEnabled: true }], issues: [] }).hasLabels('acme/web', ['status:in progress', 'area:sync']);
    const lines = await expectRun(kit, ['issue', 'migrate', 'rows.jsonl', '--yes'], gh, EXIT.ok);
    assert.ok(!lines.some((line) => line.includes('SKIPPED')), lines.join('\n'));
    assert.deepEqual(createsOf(gh).map((args) => args.slice(8)), [
      ['-f', 'type=Bug', '-f', 'labels[]=bug', '-f', 'labels[]=p0', '-f', 'labels[]=status:in progress', '-f', 'labels[]=area:sync', '-f', 'assignees[]=octocat'],
    ]);
  });

  it('opens nothing while GitHub is off on the machine', async () => {
    const kit = await migratingTeam();
    const gh = new FakeGh();
    const result = await kit.run(['issue', 'migrate', 'rows.jsonl', '--yes'], { gh, env: { TEAMRIG_SESSION: 'lead', TEAMRIG_GITHUB: 'off' } });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.match(result.stdout.join('\n'), /^OFF /u);
    assert.deepEqual(gh.ran, []);
  });

  it('refuses a bad row file, naming the line, and a missing one', async () => {
    const kit = await migratingTeam();
    await kit.files.write(ROWS, `\n${issueRow('T1', 'acme/web', 'x', { status: 'open' })}`);
    const bad = await kit.run(['issue', 'migrate', 'rows.jsonl'], { ...AS_LEAD, gh: new FakeGh() });
    assert.equal(bad.code, EXIT.refused);
    assert.match(bad.stdout.join('\n'), /^REFUSED .*rows\.jsonl: line 2: T1: unknown key status$/u);
    const missing = await kit.run(['issue', 'migrate', 'none.jsonl'], { ...AS_LEAD, gh: new FakeGh() });
    assert.equal(missing.code, EXIT.refused);
    assert.match(missing.stdout.join('\n'), /^REFUSED no row file .*none\.jsonl$/u);
  });
});
