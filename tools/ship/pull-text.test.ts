import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PULL_TEXT_FILE, pullTextOf, reachOf, taskPullTextFile } from './pull-text.ts';

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

  it('takes --note-file over the task file, and the task file without one', () => {
    assert.deepEqual(pullTextOf('C:/notes/pr.md', 'C:/tasks/T1/pr.md', read), { kind: 'found', text: 'Reach: all users\n' });
    assert.deepEqual(pullTextOf(null, 'C:/tasks/T1/pr.md', read), { kind: 'found', text: '## Reach\nteamrig development\n' });
  });

  it('throws for a missing --note-file, as a usage error', () => {
    assert.throws(() => pullTextOf('C:/notes/none.md', 'C:/tasks/T1/pr.md', read), /^Error: --note-file C:\/notes\/none\.md: no such file$/);
  });

  it('refuses no text, naming where to write it, and a text stating no Reach, naming its file', () => {
    assert.deepEqual(pullTextOf(null, 'C:/tasks/T9/pr.md', read), {
      kind: 'refused',
      reason:
        'the pull request this merge opens has no text: write the pull request text (What, Why and a Reach line: all users, teamrig development or one team, CONTRIBUTING.md, Where a change lives) in C:/tasks/T9/pr.md, or pass --note-file <path>',
    });
    const untasked = pullTextOf(null, null, read);
    assert.equal(untasked.kind, 'refused');
    assert.match(untasked.kind === 'refused' ? untasked.reason : '', /pass --note-file <path>, as this branch names no task of a set team$/);
    const bare = pullTextOf(null, 'C:/tasks/T2/pr.md', read);
    assert.match(bare.kind === 'refused' ? bare.reason : '', /^C:\/tasks\/T2\/pr\.md states no Reach: add a `Reach:` line/);
    const note = pullTextOf('C:/tasks/T2/pr.md', null, read);
    assert.match(note.kind === 'refused' ? note.reason : '', /^--note-file C:\/tasks\/T2\/pr\.md states no Reach/);
  });
});
