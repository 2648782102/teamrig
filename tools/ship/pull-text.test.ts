import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CONFIG_VERSION } from '../../src/config/types.ts';
import { ENV } from '../../src/core/home.ts';
import { SecretScanner } from '../../src/core/secrets.ts';
import { PULL_TEXT_FILE, type PullText, pullTextOf, reachOf, taskPullTextFile, teamSecretScanner } from './pull-text.ts';

describe('reachOf', () => {
  it('reads a Reach line, trimmed', () => {
    assert.equal(reachOf('Reach:  all users (plugin)  \n\n## What\nx\n'), 'all users (plugin)');
  });

  it("reads a Reach section's body up to the next heading, the template's hints left out", () => {
    const text = '## What\nx\n\n## Reach\n<!-- All users or one team -->\nteamrig development:\ntools/ship only\n\n## Tests\ny\n';
    assert.equal(reachOf(text), 'teamrig development:\ntools/ship only');
    assert.equal(reachOf('## Reach\none team\n'), 'one team');
  });

  it('is null when neither a line nor a section says anything', () => {
    for (const text of ['## What\nx\n', 'Reach:\n', '## Reach\n<!-- hint -->\n\n## Tests\ny\n', '## Reach\n   \n', 'Reach: <!-- fill in -->\n', '### Reach\nnot a section\n']) {
      assert.equal(reachOf(text), null, JSON.stringify(text));
    }
  });

  it('takes a filled section when the Reach line is empty', () => {
    assert.equal(reachOf('Reach:\n\n## Reach\nall users\n'), 'all users');
  });
});

describe('taskPullTextFile', () => {
  const home = join('/home', 'dev');

  it("names pr.md in the branch's task folder of the caller's team, under TEAMRIG_HOME when set", () => {
    assert.equal(taskPullTextFile({ TEAMRIG_TEAM: 'alpha' }, home, 'feat/t12-parse-input'), join(home, '.teamrig', 'teams', 'alpha', 'tasks', 'T12', PULL_TEXT_FILE));
    assert.equal(taskPullTextFile({ TEAMRIG_TEAM: 'alpha', TEAMRIG_HOME: join('/kit') }, home, 't7-fix-2'), join('/kit', 'teams', 'alpha', 'tasks', 'T7', PULL_TEXT_FILE));
  });

  it('is null for a branch that names no task, or with no team set', () => {
    assert.equal(taskPullTextFile({ TEAMRIG_TEAM: 'alpha' }, home, 'docs-typo'), null);
    assert.equal(taskPullTextFile({}, home, 't12-parse'), null);
    assert.equal(taskPullTextFile({ TEAMRIG_TEAM: '  ' }, home, 't12-parse'), null);
  });
});

describe('pullTextOf', () => {
  const files: Readonly<Record<string, string>> = {
    'C:/notes/pr.md': 'Reach: all users\n',
    'C:/tasks/T1/pr.md': '## Reach\nteamrig development\n',
    'C:/tasks/T2/pr.md': '## What\nx\n',
  };
  const read = (path: string): string | null => files[path] ?? null;
  const scanner = new SecretScanner(['tok_[a-z0-9]{8}']);
  const pullText = (noteFile: string | null, taskFile: string | null, readText = read): PullText => pullTextOf(noteFile, taskFile, readText, scanner);

  it('takes --note-file over the task file, and the task file without one', () => {
    assert.deepEqual(pullText('C:/notes/pr.md', 'C:/tasks/T1/pr.md'), { kind: 'found', text: 'Reach: all users\n' });
    assert.deepEqual(pullText(null, 'C:/tasks/T1/pr.md'), { kind: 'found', text: '## Reach\nteamrig development\n' });
  });

  it('throws for a missing --note-file, as a usage error', () => {
    assert.throws(() => pullText('C:/notes/none.md', 'C:/tasks/T1/pr.md'), /^Error: --note-file C:\/notes\/none\.md: no such file$/);
  });

  it("refuses a text holding a secret's shape, from either source, naming the file and never the value", () => {
    const secret = ['tok', 'abcd1234'].join('_');
    const leaky = (path: string): string | null => (path.endsWith('pr.md') ? `Reach: all users\n\nRan it with ${secret} set.\n` : null);
    const task = pullText(null, 'C:/tasks/T1/pr.md', leaky);
    assert.equal(task.kind, 'refused');
    assert.match(task.kind === 'refused' ? task.reason : '', /^C:\/tasks\/T1\/pr\.md looks like it holds a secret \(.+\); refer to where it is kept instead, as the pull request is public$/u);
    const note = pullText('C:/notes/pr.md', null, leaky);
    assert.match(note.kind === 'refused' ? note.reason : '', /^--note-file C:\/notes\/pr\.md looks like it holds a secret/u);
    for (const refused of [task, note]) assert.doesNotMatch(refused.kind === 'refused' ? refused.reason : secret, new RegExp(secret, 'u'));
  });

  it('refuses a text holding private data, naming its shape and never the value', () => {
    const host = ['ci-runner', 'corp'].join('.');
    const leaky = (): string => `Reach: all users\n\nThe log on ${host} shows it.\n`;
    const refused = pullText(null, 'C:/tasks/T1/pr.md', leaky);
    assert.deepEqual(refused, {
      kind: 'refused',
      reason: 'C:/tasks/T1/pr.md holds private data (internal host name): take it out, as the pull request is public',
    });
  });

  it('refuses no text, naming where to write it, and a text stating no Reach, naming its file', () => {
    assert.deepEqual(pullText(null, 'C:/tasks/T9/pr.md'), {
      kind: 'refused',
      reason:
        'the pull request this merge opens has no text: write the pull request text (What, Why and a Reach line: all users, teamrig development or one team, CONTRIBUTING.md, Where a change lives) in C:/tasks/T9/pr.md, or pass --note-file <path>',
    });
    const untasked = pullText(null, null);
    assert.equal(untasked.kind, 'refused');
    assert.match(untasked.kind === 'refused' ? untasked.reason : '', /pass --note-file <path>, as this branch names no task of a set team$/);
    const bare = pullText(null, 'C:/tasks/T2/pr.md');
    assert.match(bare.kind === 'refused' ? bare.reason : '', /^C:\/tasks\/T2\/pr\.md states no Reach: add a `Reach:` line/);
    const note = pullText('C:/tasks/T2/pr.md', null);
    assert.match(note.kind === 'refused' ? note.reason : '', /^--note-file C:\/tasks\/T2\/pr\.md states no Reach/);
  });
});

describe('teamSecretScanner', () => {
  const kitHome = join('C:', 'kit');
  const env = { [ENV.home]: kitHome, [ENV.team]: 'acme' };
  const configFile = join(kitHome, 'teams', 'acme', 'config.json');
  const secret = ['tok', 'abcd1234'].join('_');
  const configOf = (text: string) => (path: string): string | null => (path === configFile ? text : null);

  it("scans with the merge's team's secretPatterns", () => {
    const config = JSON.stringify({ configVersion: CONFIG_VERSION, register: { secretPatterns: ['tok_[a-z0-9]{8}'] } });
    assert.notEqual(teamSecretScanner(env, 'C:/home', configOf(config)).refusal('pr.md', `uses ${secret}`), undefined);
  });

  it('keeps the built-in shapes with no team, no config or an unreadable one', () => {
    const builtIn = `uses ${['ghp', 'a'.repeat(36)].join('_')}`;
    for (const scanner of [
      teamSecretScanner({ [ENV.home]: kitHome }, 'C:/home', configOf('{}')),
      teamSecretScanner(env, 'C:/home', () => null),
      teamSecretScanner(env, 'C:/home', configOf('{ not json')),
    ]) {
      assert.notEqual(scanner.refusal('pr.md', builtIn), undefined);
      assert.equal(scanner.refusal('pr.md', `uses ${secret}`), undefined);
    }
  });
});
