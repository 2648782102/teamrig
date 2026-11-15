import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import type { ClearPull, MergeClearance } from './approval.ts';
import type { Gh } from './github.ts';
import type { GateDeps } from './local-gate.ts';
import type { Waiter } from './merge.ts';
import { GUARDED_PATHS, type MergePrArgs, type MergePrDeps, guardedOf, mergePrCommand, parseMergePrArgs, releaseOf, releasePlan, runMergePr } from './merge-pr.ts';
import { TEAMRIG_REGENERATION } from './regenerate.ts';
import { parseProfiles } from './repos.ts';

const REPO = 'Owner/teamrig';
const SECRET = ['github', '_pat_', 'x'].join('');
/** main before the merge, after the contributor's pull request, and after its release. */
const BASE = 'base000aaa';
const MERGED = 'main999bbb';
const RELEASED = 'main1000cc';
/** The contributor's head, and the release head the merge cuts. */
const SHA = `abc1234def${'0'.repeat(30)}`;
const RELEASE_SHA = 'rel5678abc';
const PULL = 7;
const RELEASE_PULL = 8;
const BRANCH = 't3029-release-pr7';
const PLUGIN_JSON = 'plugins/teamrig/.claude-plugin/plugin.json';
const VERSION_TS = 'src/core/version.ts';
const pluginJson = (version: string): string => `{"name":"teamrig","version":"${version}"}`;
const versionTs = (version: string): string => `export const KIT_VERSION = '${version}';\n`;

const ARGS: MergePrArgs = { dir: 'C:/repo', pull: PULL, approved: SHA, task: 'T3029', raise: 'patch', timeoutMin: 10, intervalS: 60 };

interface Fixture {
  /** What the contributor's pull request changes over main. */
  changed?: readonly string[];
  /** The version at the contributor's head; main's is 0.400.0. */
  headVersion?: string;
  /** Whether the head contains main's tip. */
  behind?: boolean;
  /** What GitHub shows of the pull request. */
  pull?: { state?: string; merged?: boolean; base?: string; headSha?: string; maintainerCanModify?: boolean; headRepo?: string | null };
  clearance?: MergeClearance;
  /** What the dist build writes; nothing by default. */
  distBuilt?: readonly string[];
  /** Extra paths the release shows changed, as a build that writes outside the dist would. */
  strayRelease?: readonly string[];
  status?: string;
  /** What the credential lookup finds; a token by default. */
  credential?: ReturnType<MergePrDeps['credential']>;
  /** A repo that regenerates nothing, so no release follows the merge. */
  noRegeneration?: boolean;
  /** The conclusion of the gates job on the contributor's head. */
  conclusion?: string;
}

/** A clock that only moves when the code under test sleeps. */
const waiter = (): Waiter => {
  let now = 0;
  return { now: () => now, sleep: async (ms) => void (now += ms) };
};

/** Local-gate deps that are never reached on the `ci` gate. */
const unusedGate = (): GateDeps => ({
  git: () => {
    throw new Error('the local gate is not used');
  },
  exists: () => false,
  readText: () => null,
  writeText: () => undefined,
  run: () => ({ status: 1, output: '', ms: 0 }),
  now: () => new Date(0),
  log: () => undefined,
});

const pullJson = (number: number, sha: string, ref: string, options: NonNullable<Fixture['pull']> = {}): string =>
  JSON.stringify({
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    title: number === PULL ? 'docs: fix a typo' : 'release',
    state: options.state ?? 'open',
    merged: options.merged ?? false,
    maintainer_can_modify: options.maintainerCanModify ?? false,
    head: { ref, sha: options.headSha ?? sha, repo: options.headRepo === null ? null : { full_name: options.headRepo ?? 'someone/teamrig' } },
    base: { ref: options.base ?? 'main' },
  });

function fixture(options: Fixture = {}) {
  const calls: string[] = [];
  const files = new Map<string, string>([
    [PLUGIN_JSON, pluginJson('0.400.0')],
    [VERSION_TS, versionTs('0.400.0')],
  ]);
  let merges = 0;
  let built: readonly string[] = [];
  const mainTip = (): string => [BASE, MERGED, RELEASED][merges] ?? RELEASED;
  const answers = (key: string): string | undefined => {
    const fixed: Record<string, string> = {
      'remote get-url origin': `git@github.com:${REPO}.git`,
      'status --porcelain': options.status ?? '',
      'rev-parse refs/remotes/origin/main': mainTip(),
      'rev-parse FETCH_HEAD': SHA,
      [`diff --name-only --no-renames ${BASE}...${SHA}`]: (options.changed ?? ['src/cli/a.ts']).join('\n'),
      [`merge-base ${SHA} ${BASE}`]: options.behind === true ? 'older0000' : BASE,
      [`merge-base ${BASE} ${SHA}`]: BASE,
      [`show ${SHA}:${PLUGIN_JSON}`]: pluginJson(options.headVersion ?? '0.400.0'),
      [`show ${BASE}:${PLUGIN_JSON}`]: pluginJson('0.400.0'),
      [`show ${MERGED}:${PLUGIN_JSON}`]: pluginJson('0.400.0'),
      [`rev-parse ${SHA}^{tree}`]: 'tree-pr',
      [`rev-parse ${MERGED}^{tree}`]: 'tree-pr',
      [`rev-parse ${RELEASE_SHA}^{tree}`]: 'tree-release',
      [`rev-parse ${RELEASED}^{tree}`]: 'tree-release',
      [`branch --list ${BRANCH}`]: '',
      [`ls-remote --heads origin refs/heads/${BRANCH}`]: '',
      'diff --cached --numstat': built.map((path) => `1\t1\t${path}`).join('\n'),
      [`diff --name-only --no-renames ${MERGED} HEAD`]: [...calls.filter((call) => call.startsWith('commit ')).length > 0 ? [PLUGIN_JSON, VERSION_TS] : [], ...built, ...(options.strayRelease ?? [])].join('\n'),
      'rev-parse --abbrev-ref HEAD': BRANCH,
      'rev-parse HEAD': RELEASE_SHA,
      [`rev-parse refs/heads/${BRANCH}`]: RELEASE_SHA,
      [`rev-parse refs/remotes/origin/${BRANCH}`]: RELEASE_SHA,
      [`log --reverse --format=%s refs/remotes/origin/main..${RELEASE_SHA}`]: 'plugin: version 0.400.1, the release of #7\nbuild: rebuild the plugin dist',
      [`merge-base ${RELEASE_SHA} ${MERGED}`]: MERGED,
    };
    return fixed[key];
  };
  const WRITES = ['fetch ', 'switch ', 'add ', 'commit ', 'push ', 'branch --quiet --delete '];
  const git = (...args: string[]): string => {
    const key = args.join(' ');
    calls.push(key);
    const answer = answers(key);
    if (answer !== undefined) return answer;
    if (WRITES.some((write) => key.startsWith(write))) return '';
    throw new Error(`unexpected git ${key}`);
  };
  const ghCalls: string[] = [];
  const gh = mock.fn<Gh>((args) => {
    const path = args[1] ?? '';
    ghCalls.push(path);
    if (path === `repos/${REPO}/pulls/${PULL}`) return pullJson(PULL, SHA, 'fix-typo', options.pull);
    if (path === `repos/${REPO}/pulls/${PULL}/merge`) {
      merges = 1;
      return `{"sha":"${MERGED}","merged":true,"message":"merged"}`;
    }
    if (path.startsWith(`repos/${REPO}/pulls?state=open`)) return '[]';
    if (path === `repos/${REPO}/pulls`) return pullJson(RELEASE_PULL, RELEASE_SHA, BRANCH);
    if (path === `repos/${REPO}/pulls/${RELEASE_PULL}/merge`) {
      merges = 2;
      return `{"sha":"${RELEASED}","merged":true,"message":"merged"}`;
    }
    const run = /actions\/runs\?head_sha=(\w+)/.exec(path);
    if (run !== null) {
      const branch = run[1] === SHA ? 'fix-typo' : BRANCH;
      return JSON.stringify({ workflow_runs: [{ id: 1, workflow_id: 1, event: 'pull_request', run_number: 1, run_attempt: 1, head_branch: branch }] });
    }
    if (path.includes('/actions/runs/1/jobs')) return JSON.stringify({ jobs: [{ name: 'gates', status: 'completed', conclusion: merges === 0 ? (options.conclusion ?? 'success') : 'success', steps: [{ name: 'Set up job' }] }] });
    if (path.endsWith('/status')) return '{"statuses":[]}';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  });
  const out: string[] = [];
  const err: string[] = [];
  const credential = mock.fn<MergePrDeps['credential']>(() => options.credential ?? { kind: 'found', secret: SECRET });
  const clearPull = mock.fn<ClearPull>(() => Promise.resolve(options.clearance ?? { kind: 'approved', by: 'lead' }));
  const sweep = mock.fn<MergePrDeps['sweep']>(() => undefined);
  const deps: MergePrDeps = {
    git,
    profiles: parseProfiles(`{"${REPO}":{"main":"main","gate":"ci","checks":["gates"],"regenerated":${options.noRegeneration === true ? '[]' : `["plugins/teamrig/dist/","${PLUGIN_JSON}","${VERSION_TS}"]`}}}`),
    credential,
    ghFor: () => gh,
    waiter: waiter(),
    gate: unusedGate(),
    renamedCallers: () => null,
    sweep,
    clearMerge: () => Promise.reject(new Error('merge-pr clears through clearPull')),
    catchUp: () => ({ kind: 'refused', reason: 'never caught up' }),
    clearPull,
    files: {
      readText: (path) => files.get(path) ?? '',
      writeText: (path, text) => void files.set(path, text),
      build: () => {
        built = options.distBuilt ?? [];
      },
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, calls, ghCalls, out, err, files, credential, clearPull, sweep };
}

describe('parseMergePrArgs', () => {
  it('reads the repo dir, the number, the approval and the task, a patch raise by default', () => {
    assert.deepEqual(parseMergePrArgs(['C:/repo', '7', '--approved', SHA, '--task', 'T3029']), { ...ARGS, timeoutMin: 45, intervalS: 30 });
    assert.equal(parseMergePrArgs(['C:/repo', '7', '--task', 'T1', '--approved', SHA, '--raise', 'minor']).raise, 'minor');
  });

  it('refuses a missing approval or task, a bad number, raise or flag', () => {
    assert.throws(() => parseMergePrArgs(['C:/repo', '7', '--task', 'T1']), /--approved and --task are required/);
    assert.throws(() => parseMergePrArgs(['C:/repo', '7', '--approved', SHA]), /--approved and --task are required/);
    assert.throws(() => parseMergePrArgs(['C:/repo', '07', '--approved', SHA, '--task', 'T1']), /usage: ship\.ts merge-pr/);
    assert.throws(() => parseMergePrArgs(['--approved', SHA]), /usage: ship\.ts merge-pr/);
    assert.throws(() => parseMergePrArgs(['C:/repo', '7', '--approved', SHA, '--task', 'T1', '--raise', 'huge']), /got --raise huge/);
    assert.throws(() => parseMergePrArgs(['C:/repo', '7', '--approved', 'HEAD', '--task', 'T1']), /got --approved HEAD/);
    assert.throws(() => parseMergePrArgs(['C:/repo', '7', '--approved', SHA.slice(0, 12), '--task', 'T1']), /got --approved abc1234def00/, 'a contributor head is approved by its full sha (T3052 F1)');
    assert.throws(() => parseMergePrArgs(['C:/repo', '7', '--task']), /--task needs a value/);
  });
});

describe('guardedOf', () => {
  it('keeps the paths under a guarded folder: the guards, CI and the ship tools', () => {
    assert.deepEqual(guardedOf(['docs/a.md', 'src/push-guard/guard.ts', '.github/workflows/ci.yml', 'tools/ship/merge.ts', 'src/cli/a.ts']), ['src/push-guard/guard.ts', '.github/workflows/ci.yml', 'tools/ship/merge.ts']);
  });

  it('keeps what drives the gates and the build too: their libraries, scripts, dependencies and the approval logic (T3052 F2)', () => {
    const drivers = ['tools/lib/git.ts', 'tools/dco/dco.ts', 'tools/build/build.ts', 'package.json', 'package-lock.json', '.npmrc', 'tsconfig.json', 'tsconfig.build.json', 'src/cli/ship-approval.ts', 'src/register/approval.ts'];
    assert.deepEqual(guardedOf([...drivers, 'src/register/register.ts', 'docs/package.json.md']), drivers);
  });

  it("is the list CONTRIBUTING.md's review rule names, so the doc and the merge gate stay one", () => {
    const review = /- \*\*Review\*\*:[\s\S]*?\(the guarded paths: ([^)]*)\)/.exec(readFileSync(new URL('../../CONTRIBUTING.md', import.meta.url), 'utf8'));
    assert.ok(review !== null, 'CONTRIBUTING.md has its Review rule with the guarded paths');
    const named = [...(review[1] ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert.deepEqual([...named].sort(), [...GUARDED_PATHS].sort());
  });
});

describe('releaseOf and releasePlan', () => {
  const { deps } = fixture({ headVersion: '0.400.0' });

  it('raises the version when the change reaches installs and raised none', () => {
    assert.deepEqual(releaseOf(deps.git, TEAMRIG_REGENERATION, BASE, SHA, ['src/cli/a.ts'], 'minor'), { raise: 'minor' });
    assert.deepEqual(releaseOf(deps.git, TEAMRIG_REGENERATION, BASE, SHA, ['plugins/teamrig/skills/a/SKILL.md'], 'patch'), { raise: 'patch' });
  });

  it('raises nothing for a change outside the plugin and its source, or one that raised the version itself', () => {
    assert.deepEqual(releaseOf(deps.git, TEAMRIG_REGENERATION, BASE, SHA, ['docs/a.md', 'tools/ci/x.ts'], 'patch'), { raise: null });
    const raised = fixture({ headVersion: '0.401.0' });
    assert.deepEqual(releaseOf(raised.deps.git, TEAMRIG_REGENERATION, BASE, SHA, ['src/cli/a.ts'], 'patch'), { raise: null });
  });

  it("plans the raise from the tip's version, naming the pull request, and always the dist", () => {
    const plan = releasePlan(deps.git, TEAMRIG_REGENERATION, { raise: 'patch' }, PULL, MERGED);
    assert.deepEqual([plan.work, plan.rebuild, plan.raise?.kind, plan.raise?.set], [[], true, 'patch', { major: 0, minor: 400, patch: 1 }]);
    assert.match(plan.raise?.message ?? '', /^plugin: version 0\.400\.1, the release of #7\n/);
    assert.match(plan.raise?.message ?? '', /Co-Authored-By: /);
    assert.deepEqual(releasePlan(deps.git, TEAMRIG_REGENERATION, { raise: null }, PULL, MERGED), { work: [], raise: null, rebuild: true });
  });
});

describe('runMergePr (T3029)', () => {
  it("merges the approved head pinned to it, then cuts, pushes and merges the release that raises the version and rebuilds the dist", async () => {
    const { deps, calls, ghCalls, out, err, files, clearPull, sweep } = fixture({ distBuilt: ['plugins/teamrig/dist/cli/main.js'] });
    assert.equal(await runMergePr(ARGS, deps), 0, err.join('\n'));
    assert.deepEqual(err, []);
    assert.deepEqual(clearPull.mock.calls.map((call) => call.arguments), [['T3029', SHA, SHA, []]]);
    assert.ok(ghCalls.includes(`repos/${REPO}/pulls/${PULL}/merge`));
    assert.ok(out.includes(`MERGED #${PULL} into main, now at ${MERGED.slice(0, 7)}`), out.join('\n'));
    assert.ok(calls.includes(`switch --quiet --create ${BRANCH} ${MERGED}`), 'the release is cut from the merged main');
    assert.ok(calls.includes(`push --quiet origin HEAD:refs/heads/${BRANCH}`));
    assert.equal(files.get(PLUGIN_JSON), pluginJson('0.400.1'));
    assert.equal(files.get(VERSION_TS), versionTs('0.400.1'));
    assert.equal(out.at(-1), `MERGED #${RELEASE_PULL} into main, now at ${RELEASED.slice(0, 7)}`);
    assert.deepEqual(sweep.mock.calls.map((call) => call.arguments[0].head), [BRANCH], "only the release's own head is swept, never the contributor's");
  });

  it('passes the guarded paths the head changes to the clearance, and stops on its refusal before the token is read', async () => {
    const { deps, credential, clearPull, err } = fixture({ changed: ['tools/ship/merge.ts', 'docs/a.md'], clearance: { kind: 'refused', reason: 'needs a security pass' } });
    assert.equal(await runMergePr(ARGS, deps), 1);
    assert.deepEqual(clearPull.mock.calls[0]?.arguments[3], ['tools/ship/merge.ts']);
    assert.deepEqual(err, ['REFUSED needs a security pass']);
    assert.equal(credential.mock.callCount(), 0);
  });

  it('refuses a head that moved past the approval before any GitHub call: a new commit needs a new approval', async () => {
    const { deps, credential, clearPull, err } = fixture();
    const twin = `${SHA.slice(0, 12)}${'f'.repeat(28)}`;
    assert.equal(await runMergePr({ ...ARGS, approved: twin }, deps), 1);
    assert.equal(err[0], `REFUSED #7's head is ${SHA}, not the approved ${twin}: a commit pushed after the approval needs the lead's approval of the new head`);
    assert.equal(clearPull.mock.callCount(), 0);
    assert.equal(credential.mock.callCount(), 0);
  });

  it('refuses a head behind main, saying who rebases it', async () => {
    const own = fixture({ behind: true });
    assert.equal(await runMergePr(ARGS, own.deps), 1);
    assert.match(own.err[0] ?? '', /#7 abc1234 does not contain main base000: its author rebases it onto main/);
    assert.ok(!own.ghCalls.includes(`repos/${REPO}/pulls/${PULL}/merge`));
    const editable = fixture({ behind: true, pull: { maintainerCanModify: true } });
    assert.equal(await runMergePr(ARGS, editable.deps), 1);
    assert.match(editable.err[0] ?? '', /its author, or a maintainer since it lets maintainers edit it, rebases it/);
  });

  it('refuses a pull request that is closed, merged, into another branch, or whose head moved on GitHub', async () => {
    const cases: [NonNullable<Fixture['pull']>, RegExp][] = [
      [{ state: 'closed' }, /#7 is closed already/],
      [{ state: 'closed', merged: true }, /#7 is merged already/],
      [{ base: 'next' }, /#7 goes into next, not main/],
      [{ headSha: 'ffff000111' }, /#7's head moved to ffff00011 while it was read/],
    ];
    for (const [pull, reason] of cases) {
      const { deps, err, ghCalls } = fixture({ pull });
      assert.equal(await runMergePr(ARGS, deps), 1);
      assert.match(err[0] ?? '', reason);
      assert.ok(!ghCalls.some((path) => path.endsWith('/merge')));
    }
  });

  it('releases nothing when the change reaches no install, and deletes the empty release branch', async () => {
    const { deps, calls, out, err } = fixture({ changed: ['docs/a.md'] });
    assert.equal(await runMergePr(ARGS, deps), 0, err.join('\n'));
    assert.equal(out.at(-1), 'RELEASED nothing: #7 leaves the version and the dist as they are');
    assert.ok(calls.includes(`branch --quiet --delete ${BRANCH}`));
    assert.ok(!calls.some((call) => call.startsWith('push ')));
  });

  it('refuses to push a release that changes anything beyond the version and the dist', async () => {
    const { deps, calls, err } = fixture({ strayRelease: ['src/cli/a.ts'] });
    assert.equal(await runMergePr(ARGS, deps), 1);
    assert.match(err[0] ?? '', /the release t3029-release-pr7 changes src\/cli\/a\.ts, beyond the version and the dist: nothing was pushed/);
    assert.ok(!calls.some((call) => call.startsWith('push ')));
  });

  it('refuses a dirty repo dir, where the release would be cut, before anything else', async () => {
    const { deps, calls, err } = fixture({ status: ' M src/a.ts' });
    assert.equal(await runMergePr(ARGS, deps), 1);
    assert.match(err[0] ?? '', /has uncommitted changes, and the release is cut there/);
    assert.ok(!calls.some((call) => call.startsWith('fetch ')));
  });

  it('stops with no GitHub token, saying why', async () => {
    const { deps, err, ghCalls } = fixture({ credential: { kind: 'missing' } });
    assert.equal(await runMergePr(ARGS, deps), 1);
    assert.equal(err.length, 1);
    assert.deepEqual(ghCalls, []);
  });

  it('refuses a head whose checks failed, and cuts no release', async () => {
    const { deps, calls, err, ghCalls } = fixture({ conclusion: 'failure' });
    assert.equal(await runMergePr({ ...ARGS, timeoutMin: 1 }, deps), 1);
    assert.match(err[0] ?? '', /^REFUSED /);
    assert.ok(!ghCalls.some((path) => path.endsWith('/merge')));
    assert.ok(!calls.some((call) => call.startsWith('switch ')));
  });

  it("merges on the caller's own clearance in a repo that regenerates nothing: no clean tree needed, no release", async () => {
    const { deps, calls, out, err } = fixture({ noRegeneration: true, status: ' M src/a.ts', clearance: { kind: 'self' }, pull: { headRepo: null } });
    assert.equal(await runMergePr(ARGS, deps), 0, err.join('\n'));
    assert.ok(out.includes(`merge of #${PULL} abc1234de: the caller's own, a root team's lead`), out.join('\n'));
    assert.ok(out.includes(`#${PULL} https://github.com/${REPO}/pull/${PULL} from a deleted fork`), out.join('\n'));
    assert.ok(!out.some((line) => line.includes('fix a typo')), "the contributor's title never reaches the output (T3052 N1)");
    assert.equal(out.at(-1), `MERGED #${PULL} into main, now at ${MERGED.slice(0, 7)}`);
    assert.ok(!calls.some((call) => call.startsWith('switch ') || call === 'status --porcelain'));
  });
});

describe('mergePrCommand', () => {
  it('prints a usage error as one line and exits 1', async () => {
    const lines: string[] = [];
    const error = mock.method(console, 'error', (line: string) => lines.push(line));
    try {
      assert.equal(await mergePrCommand(['C:/repo']), 1);
    } finally {
      error.mock.restore();
    }
    assert.match(lines[0] ?? '', /^usage: ship\.ts merge-pr/);
  });

  it("runs the merge on the deps of the repo dir, a git failure as one line on the deps' err", async () => {
    const { deps, err } = fixture();
    const failing: MergePrDeps = {
      ...deps,
      git: () => {
        throw new Error('git failed');
      },
    };
    assert.equal(await mergePrCommand(['C:/repo', '7', '--approved', SHA, '--task', 'T3029'], () => failing), 1);
    assert.deepEqual(err, ['git failed']);
  });
});
