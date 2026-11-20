import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import type { Task } from '../register/fold.ts';
import { CliHarness, TEAM } from '../testing/cli-harness.ts';
import { testConfig } from '../testing/config.ts';
import { FakeGh } from '../testing/fake-gh.ts';
import { testTask } from '../testing/task.ts';
import { FEATURE_HINTS, OFF_HELPS_MIN_ISSUE_TASKS, offHelpsWarnings, type FeatureHint } from './off-helps-check.ts';
import { EXIT } from './runtime.ts';

/** `count` active tasks holding issues of `repo`, numbered from `first`. */
function issueTasks(repo: string, count: number, first = 1): Task[] {
  return Array.from({ length: count }, (_, index) => testTask({ id: `T${first + index}`, ref: `gh:${repo}#${first + index}` }));
}

/** The keys of the OFF-HELPS warnings for this config and these tasks. */
function warnedKeys(extra: JsonRecord, tasks: readonly Task[]): string[] {
  return offHelpsWarnings({ config: testConfig(extra), tasks }).map((warning) => warning.key);
}

describe('offHelpsWarnings: github.repos (T4584)', () => {
  it('names the repository most active tasks hold issues of, with the command that lists it', () => {
    const tasks = [...issueTasks('acme/web', 3), ...issueTasks('acme/api', 1, 10)];
    assert.deepEqual(offHelpsWarnings({ config: testConfig(), tasks }), [
      {
        key: 'off-helps github.repos',
        source: 'the feature hint check [featureHints.dismiss]',
        text:
          'OFF-HELPS github.repos is off: 3 active tasks hold issues of acme/web, linked by hand: the import makes each new issue there a task and tells ' +
          "its owner the issue's news. Turn on: teamrig config set github.repos acme/web; or add github.repos to featureHints.dismiss to stop this line",
      },
    ]);
  });

  it('counts a repository without case, and leaves out finished tasks and refs that name no issue', () => {
    const tasks = [
      testTask({ id: 'T1', ref: 'gh:Acme/Web#1' }),
      testTask({ id: 'T2', ref: 'gh:acme/web#2', status: 'done' }),
      testTask({ id: 'T3', ref: 'gh:acme/web' }),
      testTask({ id: 'T4', ref: 'local: kept off GitHub' }),
      ...issueTasks('acme/web', OFF_HELPS_MIN_ISSUE_TASKS - 1, 5),
    ];
    assert.deepEqual(warnedKeys({}, tasks), ['off-helps github.repos']);
    assert.deepEqual(warnedKeys({}, tasks.filter((task) => task.id !== 'T1')), []);
  });

  it('says nothing below the habit threshold, nor once repos are set', () => {
    assert.deepEqual(warnedKeys({}, issueTasks('acme/web', OFF_HELPS_MIN_ISSUE_TASKS - 1)), []);
    assert.deepEqual(warnedKeys({ github: { repos: ['acme/web'], statusPush: true } }, issueTasks('acme/web', 5)), []);
  });
});

describe('offHelpsWarnings: github.statusPush (T4584)', () => {
  it('counts only the tasks holding issues of the listed repositories, and names the push plan to read first', () => {
    const tasks = [...issueTasks('acme/web', 2), ...issueTasks('acme/api', 1, 10), ...issueTasks('other/site', 4, 20)];
    const [warning, ...rest] = offHelpsWarnings({ config: testConfig({ github: { repos: ['acme/web', 'acme/api'] } }), tasks });
    assert.deepEqual([warning?.key, rest], ['off-helps github.statusPush', []]);
    assert.equal(
      warning?.text,
      'OFF-HELPS github.statusPush is off: 3 active tasks hold issues of github.repos, and those issues show no task status until a session pushes it: ' +
        "the status push sends each one's labels and assignees with the automatic sync. It needs a gh login that can write issues; read its plan first " +
        '(teamrig issue sync --push). Turn on: teamrig config set github.statusPush true; or add github.statusPush to featureHints.dismiss to stop this line',
    );
  });

  it('says nothing with the push on, or too few tasks holding the listed issues', () => {
    assert.deepEqual(warnedKeys({ github: { repos: ['acme/web'], statusPush: true } }, issueTasks('acme/web', 5)), []);
    assert.deepEqual(warnedKeys({ github: { repos: ['acme/web'] } }, [...issueTasks('acme/web', 2), ...issueTasks('other/site', 5, 10)]), []);
  });
});

describe('offHelpsWarnings: the table and the dismiss key (T4584)', () => {
  it('drops a dismissed key and keeps the others', () => {
    const hint = (key: string): FeatureHint => ({ key, isOff: () => true, wouldHelp: () => `${key} helps`, turnOn: () => `turn ${key} on` });
    const context = { config: testConfig({ featureHints: { dismiss: ['a.one'] } }), tasks: [] };
    assert.deepEqual(
      offHelpsWarnings(context, [hint('a.one'), hint('b.two')]).map((warning) => warning.key),
      ['off-helps b.two'],
    );
  });

  it('asks no probe of a feature already on', () => {
    const probed: string[] = [];
    const on: FeatureHint = { key: 'c.three', isOff: () => false, wouldHelp: () => { probed.push('c.three'); return 'helps'; }, turnOn: () => 'on' };
    assert.deepEqual([offHelpsWarnings({ config: testConfig(), tasks: [] }, [on]), probed], [[], []]);
  });

  it('holds one entry per key, each a config key path', () => {
    const keys = FEATURE_HINTS.map((hint) => hint.key);
    assert.equal(new Set(keys).size, keys.length);
    keys.forEach((key) => assert.match(key, /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/u));
  });
});

describe('teamrig check OFF-HELPS (T4584)', () => {
  const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' }, gh: new FakeGh() };

  async function offHelpsRows(team: JsonRecord): Promise<string[]> {
    const kit = new CliHarness(team);
    for (const number of [1, 2, 3]) {
      const added = await kit.run(['add', '--title', `Issue ${number}`, '--description', `Issue ${number}: what and why`, '--priority', 'p2', '--ref', `gh:acme/web#${number}`], AS_LEAD);
      assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
    }
    const result = await kit.run(['check', '--all'], AS_LEAD);
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    return result.stdout.filter((line) => line.includes('OFF-HELPS'));
  }

  it("shows the lead the status push line among the unowned warnings when the team's issue tasks would use it", async () => {
    const rows = await offHelpsRows({ ...TEAM, github: { repos: ['acme/web'] } });
    assert.equal(rows.length, 1, rows.join('\n'));
    assert.match(rows[0] ?? '', /^from the feature hint check \[featureHints\.dismiss\]: OFF-HELPS github\.statusPush is off: 3 active tasks /u);
  });

  it('shows nothing once the lead dismissed it', async () => {
    assert.deepEqual(await offHelpsRows({ ...TEAM, github: { repos: ['acme/web'] }, featureHints: { dismiss: ['github.statusPush'] } }), []);
  });
});
