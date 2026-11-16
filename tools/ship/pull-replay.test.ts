import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownDiff } from './catch-up.ts';
import { type Cut, type PullReplay, replayPlan, replayPull } from './pull-replay.ts';
import { type RegenerateDeps, TEAMRIG_REGENERATION, workPathspec } from './regenerate.ts';

const PLUGIN = 'plugins/teamrig/.claude-plugin/plugin.json';
const KIT = 'src/core/version.ts';
const BRANCH = 't3341-pr7';
const pluginJson = (version: string): string => `{\n  "name": "teamrig",\n  "version": "${version}"\n}\n`;
const kitTs = (version: string): string => `export const KIT_VERSION = '${version}';\n`;
/** The contributor, whose authorship the replay keeps. */
const AUTHOR = ['-c', 'user.name=contributor', '-c', 'user.email=c@example.com'];

/**
 * A teamrig repo whose main moved to 0.2.0 (its own src/b.ts, raised, the dist rebuilt) past the base a contributor's
 * pull request was cut from; `build` writes one dist file per src file.
 */
function moved(t: { after: (fn: () => void) => void }, mainWork: Readonly<Record<string, string>> = { 'src/b.ts': 'export const b = 1;\n' }) {
  const root = mkdtempSync(join(tmpdir(), 'pull-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(root, '.no-hooks')], ['core.autocrlf', 'false']] as const) git('config', key, value);
  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const build = (): void => {
    for (const name of readdirSync(join(root, 'src')).filter((file) => file.endsWith('.ts'))) write(`plugins/teamrig/dist/${name.replace(/\.ts$/, '.js')}`, `// built\n${readFileSync(join(root, 'src', name), 'utf8')}`);
  };
  const commit = (files: Readonly<Record<string, string>>, message: string, as: readonly string[] = []): string => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git(...as, 'commit', '-q', '-s', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const raise = (version: string, as: readonly string[] = []): string => {
    commit({ [PLUGIN]: pluginJson(version), [KIT]: kitTs(version) }, `plugin: version ${version}`, as);
    build();
    return commit({}, 'build: rebuild the plugin dist', as);
  };
  commit({ 'src/a.ts': 'export const a = 1;\n', [KIT]: kitTs('0.1.0'), [PLUGIN]: pluginJson('0.1.0'), 'README.md': '# r\n' }, 'base');
  build();
  const base = commit({}, 'build: the first dist');
  commit(mainWork, 'main: its own work');
  const tip = raise('0.2.0');
  git('switch', '-q', '--create', 'contributor', base);
  const log: string[] = [];
  const deps: RegenerateDeps = { git, log: (line) => log.push(line), readText: (path) => readFileSync(join(root, path), 'utf8'), writeText: (path, text) => writeFileSync(join(root, path), text), build };
  /** The pull request's head is done: the new branch the replay runs on is checked out at main's tip. */
  const onTip = (): string => {
    const sha = git('rev-parse', 'HEAD');
    git('switch', '-q', '--create', BRANCH, tip);
    return sha;
  };
  return { root, git, build, commit, raise, base, tip, deps, onTip };
}

const at = (sha: string, tip: string): PullReplay => ({ pull: 7, sha, tip, raise: 'patch' });
const reasonOf = (cut: Cut): string => (cut.kind === 'refused' ? cut.reason : `not refused: ${cut.kind}`);

test("replays a pull request's work on main without its version and dist, in their own commits or mixed with work, keeping its author, then raises above main's version and rebuilds the dist (T3341)", (t) => {
  const { root, git, commit, raise, base, tip, deps, onTip } = moved(t);
  commit({ 'src/a.ts': 'export const a = 2;\n' }, 'a: a is 2', AUTHOR);
  raise('0.1.1', AUTHOR);
  commit({ 'docs/a.md': 'a is 3\n', 'src/a.ts': 'export const a = 3;\n', [KIT]: kitTs('0.1.2'), 'plugins/teamrig/dist/a.js': 'stale\n', 'plugins/teamrig/dist/new.js': 'theirs\n' }, 'a: a is 3, with its doc', AUTHOR);
  const sha = onTip();

  const cut = replayPull(deps, TEAMRIG_REGENERATION, at(sha, tip));

  assert.deepEqual(cut, { kind: 'cut', done: 'replayed its work without its version and dist, raised the version to 0.2.1, rebuilt the dist (1 file(s))' });
  assert.deepEqual(git('log', '--format=%s|%an', `${tip}..HEAD`).split('\n'), ['build: rebuild the plugin dist|t', 'plugin: version 0.2.1, the work of #7|t', 'a: a is 3, with its doc|contributor', 'a: a is 2|contributor']);
  assert.match(git('log', '-1', '--format=%B', 'HEAD~2'), /^a: a is 3, with its doc\n\nSigned-off-by: contributor <c@example\.com>$/, 'its message and sign-off as its author wrote them');
  assert.equal(readFileSync(join(root, KIT), 'utf8'), kitTs('0.2.1'));
  assert.equal(readFileSync(join(root, PLUGIN), 'utf8'), pluginJson('0.2.1'));
  assert.equal(git('show', 'HEAD:plugins/teamrig/dist/a.js'), '// built\nexport const a = 3;', 'the dist built from the replayed source');
  assert.equal(git('show', 'HEAD:plugins/teamrig/dist/b.js'), '// built\nexport const b = 1;', "main's own dist stays");
  assert.equal(git('ls-tree', '--name-only', 'HEAD', 'plugins/teamrig/dist/new.js'), '', 'a dist file of its own is dropped');
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(ownDiff(git, tip, 'HEAD', workPathspec(TEAMRIG_REGENERATION)), ownDiff(git, base, sha, workPathspec(TEAMRIG_REGENERATION)), 'the approved work, unchanged');
});

test('raises nothing for work outside the plugin and its source, and drops a commit of only the version files (T3341)', (t) => {
  const { git, commit, raise, tip, deps, onTip } = moved(t);
  commit({ 'docs/a.md': 'a\n' }, 'docs: a', AUTHOR);
  raise('0.1.1', AUTHOR);
  const cut = replayPull(deps, TEAMRIG_REGENERATION, at(onTip(), tip));
  assert.deepEqual(cut, { kind: 'cut', done: 'replayed its work without its version and dist, rebuilt the dist, the same as before' });
  assert.deepEqual(git('log', '--format=%s', `${tip}..HEAD`).split('\n'), ['docs: a']);
});

test('lands nothing for a pull request of only the version files and the dist (T3341)', (t) => {
  const { git, raise, tip, deps, onTip } = moved(t);
  raise('0.1.1', AUTHOR);
  const cut = replayPull(deps, TEAMRIG_REGENERATION, at(onTip(), tip));
  assert.equal(cut.kind, 'nothing');
  assert.equal(git('rev-parse', 'HEAD'), tip);
});

test('refuses work that conflicts with main, the cherry-pick aborted and the branch as main has it (T3341)', (t) => {
  const { git, commit, tip, deps, onTip } = moved(t, { 'src/a.ts': 'export const a = 5;\n' });
  commit({ 'src/a.ts': 'export const a = 2;\n' }, 'a: a is 2', AUTHOR);
  const reason = reasonOf(replayPull(deps, TEAMRIG_REGENERATION, at(onTip(), tip)));
  assert.match(reason, /^replaying its commit [0-9a-f]{9} on main [0-9a-f]{7} conflicts in its work \(src\/a\.ts\): its author rebases it onto main, then the lead approves the new head$/);
  assert.equal(git('rev-parse', 'HEAD'), tip);
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
});

test('refuses work whose diff changes on main though it applies, as when main edits a line of its context (T3341)', (t) => {
  const five = (a: number, c: number): string => `export const a = ${a};\nexport const p = 0;\nexport const c = ${c};\nexport const q = 0;\nexport const r = 0;\n`;
  const { git, commit, tip, deps } = moved(t, { 'src/a.ts': five(1, 1) });
  // The pull request starts from main's five lines and changes the first; main then changes the third, two lines
  // below: the pick applies, but the work's diff now shows main's line as its context.
  git('switch', '-q', '--create', 'from-five', `${tip}~2`);
  const sha = commit({ 'src/a.ts': five(2, 1) }, 'a: a is 2', AUTHOR);
  git('switch', '-q', 'main');
  const next = commit({ 'src/a.ts': five(1, 3) }, 'main: c is 3');
  git('switch', '-q', '--create', BRANCH, next);
  assert.match(reasonOf(replayPull(deps, TEAMRIG_REGENERATION, at(sha, next))), /^the work of #7 changes when replayed on main [0-9a-f]{7}: its author rebases it onto main, then the lead approves the new head$/);
});

test("plans the raise from the tip's version, naming the pull request, and the dist always (T3341)", (t) => {
  const { git, tip } = moved(t);
  const plan = replayPlan(git, TEAMRIG_REGENERATION, 'minor', 7, tip);
  assert.deepEqual([plan.rebuild, plan.raise?.set], [true, { major: 0, minor: 3, patch: 0 }]);
  assert.match(plan.raise?.message ?? '', /^plugin: version 0\.3\.0, the work of #7\n\n.*\n\nCo-Authored-By: /);
  assert.equal(replayPlan(git, TEAMRIG_REGENERATION, null, 7, tip).raise, null);
});
