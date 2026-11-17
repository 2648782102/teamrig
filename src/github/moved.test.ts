import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HostRepoName } from '../issues/host.ts';
import { testConfig } from '../testing/config.ts';
import { FakeIssueHost } from '../testing/fake-issue-host.ts';
import { testHostIssue as issue } from '../testing/host-issue.ts';
import { testTask } from '../testing/task.ts';
import { importRules, type ImportRules } from './map.ts';
import { formerNames, movedInto, movedLines, planRepo, underNewNames } from './moved.ts';

const RULES: ImportRules = importRules(testConfig({ github: { repos: ['acme/web'], owners: { octocat: 'bravo' } } }));

/** A host that records each repository name it is asked for, and fails those a test named. */
class ReadingHost extends FakeIssueHost {
  readonly asked: string[] = [];
  private readonly failing = new Set<string>();

  failsName(repo: string): this {
    this.failing.add(repo);
    return this;
  }

  override repoName(via: string, repo: string): Promise<HostRepoName> {
    this.asked.push(repo);
    return this.failing.has(repo) ? Promise.resolve({ kind: 'failed', reason: 'gh timed out' }) : super.repoName(via, repo);
  }
}

/** The task an earlier sync added for issue `number` of `repo`. */
function imported(id: string, repo: string, number: number) {
  return testTask({ id, title: `Issue ${number}`, owner: 'lead', source: 'github', ref: `gh:${repo}#${number}`, priority: 2 });
}

describe('formerNames', () => {
  it('names each repository outside the listed ones that holds a ref with a number the sync would add, once', () => {
    const tasks = [imported('T1', 'acme/old', 7), imported('T2', 'acme/old', 8), testTask({ id: 'T3', ref: 'gh:acme/web#7' }), testTask({ id: 'T4', ref: 'gh:acme/other#9' }), testTask({ id: 'T5', ref: 'https://example.test/7' })];
    assert.deepEqual(formerNames(tasks, ['acme/web'], new Set([7, 8])), ['acme/old']);
    assert.deepEqual(formerNames(tasks, ['acme/web'], new Set()), []);
  });
});

describe('underNewNames', () => {
  it('reads refs under a former name as the listed repository, and leaves every other task as it is', () => {
    const other = testTask({ id: 'T2', ref: 'gh:acme/other#7' });
    const [moved, kept] = underNewNames([imported('T1', 'acme/old', 7), other], new Map([['acme/old', 'acme/web']]));
    assert.equal(moved?.ref, 'gh:acme/web#7');
    assert.equal(kept, other);
  });
});

describe('movedInto', () => {
  it('keeps the former names the host now knows as the repository, reading each once a run', async () => {
    const host = new ReadingHost().moved('acme/old', 'Acme/Web').moved('acme/elsewhere', 'acme/api');
    const names = new Map<string, HostRepoName>();
    assert.deepEqual(await movedInto(host, 'acme/web', ['acme/old', 'acme/elsewhere', 'acme/gone'], names), { kind: 'read', moved: new Map([['acme/old', 'acme/web']]) });
    assert.deepEqual(await movedInto(host, 'acme/api', ['acme/elsewhere'], names), { kind: 'read', moved: new Map([['acme/elsewhere', 'acme/api']]) });
    assert.deepEqual(host.asked, ['acme/old', 'acme/elsewhere', 'acme/gone']);
  });

  it('fails when a read fails, so no issue it could not tell apart is added', async () => {
    const host = new ReadingHost().failsName('acme/old');
    assert.deepEqual(await movedInto(host, 'acme/web', ['acme/old'], new Map()), { kind: 'failed', reason: 'reading whether acme/old is now acme/web: gh timed out' });
  });
});

describe('movedLines', () => {
  it('says how many tasks hold refs under each former name and how to move them', () => {
    const tasks = [imported('T1', 'acme/old', 7), imported('T2', 'acme/old', 8), imported('T3', 'acme/web', 9)];
    assert.deepEqual(movedLines('acme/web', new Map([['acme/old', 'acme/web']]), tasks), [
      'MOVED acme/old is now acme/web: its issues match the 2 task(s) holding refs under acme/old; teamrig refs apply points them at acme/web',
    ]);
  });
});

describe('planRepo', () => {
  const READ = { repo: 'acme/web', listed: ['acme/web'] };

  it('adds no second task for an issue a task holds under the name its repository had before a move, and updates that task', async () => {
    const tasks = [imported('T1', 'acme/old', 7), testTask({ id: 'T2', ref: 'gh:acme/old#8' })];
    const host = new ReadingHost().moved('acme/old', 'acme/web');
    const planned = await planRepo(host, { ...READ, issues: [issue(7, { title: 'Renamed' }), issue(8), issue(9)], tasks }, RULES, new Map());
    assert.ok(planned.kind === 'planned');
    assert.deepEqual(
      planned.plan.steps.map((step) => [step.kind, step.ref, step.kind === 'add' ? '' : step.id]),
      [
        ['update', 'gh:acme/web#7', 'T1'],
        ['add', 'gh:acme/web#9', ''],
      ],
    );
    assert.equal(planned.plan.inserted, 1);
    assert.equal(planned.lines.length, 1);
    assert.deepEqual(host.asked, ['acme/old']);
  });

  it('adds the issues as before when the other name is no former name of the repository', async () => {
    const host = new ReadingHost().moved('acme/old', 'acme/api');
    const planned = await planRepo(host, { ...READ, issues: [issue(7)], tasks: [imported('T1', 'acme/old', 7)] }, RULES, new Map());
    assert.ok(planned.kind === 'planned');
    assert.deepEqual([planned.plan.inserted, planned.lines], [1, []]);
  });

  it('reads no name when the plan adds nothing, and fails the repository when a read fails', async () => {
    const quiet = new ReadingHost();
    const planned = await planRepo(quiet, { ...READ, issues: [issue(7)], tasks: [imported('T1', 'acme/web', 7), testTask({ id: 'T2', ref: 'gh:acme/old#7' })] }, RULES, new Map());
    assert.ok(planned.kind === 'planned' && planned.plan.inserted === 0);
    assert.deepEqual(quiet.asked, []);
    const failing = new ReadingHost().failsName('acme/old');
    assert.equal((await planRepo(failing, { ...READ, issues: [issue(7)], tasks: [imported('T1', 'acme/old', 7)] }, RULES, new Map())).kind, 'failed');
  });
});
