import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
// GitHub runs a workflow file under either extension, so a `.yaml` one is held to every rule below too.
const workflows: ReadonlyMap<string, string> = new Map(
  readdirSync(new URL('.github/workflows/', root))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, read(`.github/workflows/${name}`)]),
);

/**
 * An outside pull request's CI runs with no maintainer's click in front of it (T4648), so the rules that stand in for
 * that click say so where they fail.
 */
const REVIEWED = 'outside pull requests run CI with no maintainer click, so any change to this rule needs a security review first';

/** A workflow's lines as GitHub reads them: a `#` at a line's start or after a space opens a comment. */
function uncommented(text: string): readonly string[] {
  return text.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd());
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const unquoted = (word: string): string => word.trim().replace(/^(['"])(.*)\1$/, '$2');
const listOf = (flow: string): readonly string[] => flow.split(',').map(unquoted);

/**
 * The events that start a workflow, from its top-level `on:` in the inline (`on: push`, `on: [push, pull_request]`),
 * list (`- push`) or map (`push:`, `pull_request: {}`) form. Undefined when it cannot be read (no `on:`, two of them,
 * a flow map, an odd indent), which a caller counts as running a pull request's code: the rules fail closed.
 */
function triggersOf(text: string): readonly string[] | undefined {
  const lines = uncommented(text);
  const starts = lines.flatMap((line, at) => (/^(?:on|"on"|'on'):/.test(line) ? [at] : []));
  const [start] = starts;
  if (start === undefined || starts.length > 1) return undefined;
  const event = /^[a-z_]+$/;
  const inline = (lines[start] ?? '').replace(/^[^:]+:/, '').trim();
  if (inline !== '') {
    const flow = /^\[(.*)\]$/.exec(inline)?.[1];
    const events = flow === undefined ? [unquoted(inline)] : listOf(flow);
    return events.every((name) => event.test(name)) ? events : undefined;
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) === 0) break;
    body.push(line);
  }
  const [first] = body;
  if (first === undefined) return undefined;
  const indent = indentOf(first);
  const key = first.trimStart().startsWith('-') ? /^\s*-\s*(\S+)$/ : /^\s*([^\s:]+):(?:\s.*)?$/;
  const events: string[] = [];
  for (const line of body) {
    if (indentOf(line) > indent) continue;
    const name = indentOf(line) === indent ? key.exec(line)?.[1] : undefined;
    if (name === undefined || !event.test(unquoted(name))) return undefined;
    events.push(unquoted(name));
  }
  return events;
}

/** The events that run a pull request's code: merge_group runs a fork's commits too, in the base repository. */
const PULL_REQUEST_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'pull_request_target', 'merge_group']);
const runsPullRequestCode = (text: string): boolean =>
  triggersOf(text)?.some((name) => PULL_REQUEST_EVENTS.has(name)) ?? true;

/**
 * GitHub-hosted runner labels, allowed by name: a self-hosted runner takes any custom label, so refusing the word
 * `self-hosted` would miss one routed by its own label.
 */
const HOSTED = /^(?:ubuntu-(?:latest|\d{2}\.\d{2}(?:-arm)?)|windows-(?:latest|\d{4}|11-arm)|macos-(?:latest|\d{2}(?:-(?:large|xlarge|intel))?))$/;

/** The lines of the job holding line `at`: from its two-space id to the next line at that indent or less. */
function jobAround(lines: readonly string[], at: number): readonly string[] {
  const opens = (line: string): boolean => line.trim() !== '' && indentOf(line) <= 2;
  let start = at;
  while (start > 0 && !opens(lines[start] ?? '')) start -= 1;
  let end = at + 1;
  while (end < lines.length && !opens(lines[end] ?? '')) end += 1;
  return lines.slice(start, end);
}

/**
 * The runner labels one `runs-on:` value asks for. `${{ matrix.<key> }}` is read through the job's `<key>: [..]` list;
 * any other expression, a matrix `include:` (which can add a label), the block form and `group:` come back as they
 * are, so the label check reports them.
 */
function labelsOf(value: string, job: readonly string[]): readonly string[] {
  if (value === '') return ['runs-on in the block form'];
  const matrixKey = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value)?.[1];
  if (matrixKey !== undefined) {
    if (job.some((line) => /^\s+include:/.test(line))) return [`${value} with a matrix include`];
    const flow = job.map((line) => new RegExp(`^\\s+${matrixKey}:\\s*\\[(.*)\\]$`).exec(line)?.[1]).find((list) => list !== undefined);
    return flow === undefined ? [`${value} with no [..] list`] : listOf(flow);
  }
  const flow = /^\[(.*)\]$/.exec(value)?.[1];
  return flow === undefined ? [unquoted(value)] : listOf(flow);
}

/** Each job's runner label in a workflow that is not a GitHub-hosted one, as `<job line>: <label>`. */
function unhostedRunners(text: string): readonly string[] {
  const lines = uncommented(text);
  return lines.flatMap((line, at) => {
    const value = /^\s+runs-on:(.*)$/.exec(line)?.[1];
    if (value === undefined) return [];
    const job = jobAround(lines, at);
    return labelsOf(value.trim(), job)
      .filter((label) => !HOSTED.test(label))
      .map((label) => `${(job[0] ?? '').trim()} ${label}`);
  });
}

/** The job-level `uses:` lines: a reusable workflow, whose runners and caches this spec cannot read. */
const reusableWorkflowCalls = (text: string): readonly string[] =>
  uncommented(text).filter((line) => /^ {4}uses:/.test(line)).map((line) => line.trim());

/**
 * The lines that write an Actions cache a later run of main could restore: a caching action (actions/cache and its
 * save and restore parts, or any other whose path names a cache) or a `cache…:` input, setup-node's `cache:` too.
 * `package-manager-cache: false`, which turns setup-node's own caching off, is the one cache key let through.
 */
const cacheWrites = (text: string): readonly string[] =>
  uncommented(text)
    .filter(
      (line) =>
        /\buses:\s*['"]?[\w.-]+\/[\w./-]*cache/i.test(line) ||
        (/^\s*(?:-\s*)?[\w-]*cache[\w-]*:/i.test(line) && !/^\s*package-manager-cache:\s*false$/.test(line)),
    )
    .map((line) => line.trim());

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a package.json names its package manager (`packageManager`, or `devEngines.packageManager`), on which
 * setup-node v5 caches npm by itself with no `cache:` input. A manifest that is not an object counts as naming one.
 */
function namesPackageManager(manifest: unknown): boolean {
  if (!isRecord(manifest)) return true;
  const engines = manifest['devEngines'];
  return manifest['packageManager'] !== undefined || (isRecord(engines) && engines['packageManager'] !== undefined);
}

/** The setup-node steps that leave its own caching on (no `package-manager-cache: false` in the step). */
const setupNodeCaching = (text: string): readonly string[] =>
  uncommented(text)
    .join('\n')
    .split(/^(?=\s*-\s)/m)
    .filter((step) => /\buses:\s*actions\/setup-node@/.test(step) && !/^\s*package-manager-cache:\s*false$/m.test(step))
    .map((step) => step.trim().split('\n')[0] ?? '');

describe('every workflow', () => {
  it('is there to read', () => {
    assert.ok(workflows.has('ci.yml') && workflows.has('codeql.yml'), [...workflows.keys()].join(', '));
  });

  it('starts on no workflow_run, which runs with secrets and a write token after a fork pull request\'s run', () => {
    for (const [name, text] of workflows) {
      assert.doesNotMatch(uncommented(text).join('\n'), /\bworkflow_run\b/, `${name}: ${REVIEWED}`);
    }
    assert.match(uncommented('on:\n  workflow_run:\n    workflows: [ci]').join('\n'), /\bworkflow_run\b/);
    assert.doesNotMatch(uncommented('  # never workflow_run here').join('\n'), /\bworkflow_run\b/);
  });

  it('pins each action to a full commit SHA with its version beside it, so a moved tag cannot change what runs', () => {
    for (const [name, text] of workflows) {
      for (const [line] of text.matchAll(/^.*\buses: .+$/gm)) {
        assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${line.trim()}`);
      }
    }
  });

  it('gives the token read-only contents by default, and never runs a fork pull request with secrets', () => {
    for (const [name, text] of workflows) {
      assert.match(text, /^permissions:\n {2}contents: read\n/m, name);
      assert.doesNotMatch(text, /pull_request_target/, name);
    }
  });

  it('never merges a pull request, so no dependency update lands without a person checking it', () => {
    for (const [name, text] of workflows) {
      assert.doesNotMatch(text, /gh pr merge|--auto\b|enablePullRequestAutoMerge|dependabot\/fetch-metadata/, name);
    }
  });

  it('writes pull requests only from release.yml, once, to open the release pull request a person merges', () => {
    for (const [name, text] of workflows) {
      assert.equal(text.match(/pull-requests: write/g)?.length ?? 0, name === 'release.yml' ? 1 : 0, name);
    }
  });
});

describe("a workflow that runs a pull request's code", () => {
  const pullRequestRuns = [...workflows].filter(([, text]) => runsPullRequestCode(text));

  it('is found from its triggers: ci.yml and codeql.yml', () => {
    assert.deepEqual(pullRequestRuns.map(([name]) => name).sort(), ['ci.yml', 'codeql.yml']);
  });

  it('reads the triggers in each form, and counts a workflow whose triggers it cannot read as running one', () => {
    assert.deepEqual(triggersOf('on: pull_request\n'), ['pull_request']);
    assert.deepEqual(triggersOf("on: [push, 'merge_group']\n"), ['push', 'merge_group']);
    assert.deepEqual(triggersOf('"on":\n  - push\n  - pull_request\njobs:\n'), ['push', 'pull_request']);
    assert.deepEqual(
      triggersOf('on:\n  # a comment\n  push:\n    branches: [main]\n\n  pull_request: {}\n  schedule:\n    - cron: x\njobs:\n'),
      ['push', 'pull_request', 'schedule'],
    );
    for (const unreadable of ['name: x\n', 'on: {push: {}}\n', 'on:\njobs:\n', 'on: push\non: pull_request\n', 'on:\n    push:\n  pull_request:\n']) {
      assert.equal(triggersOf(unreadable), undefined, unreadable);
      assert.equal(runsPullRequestCode(unreadable), true, unreadable);
    }
    assert.equal(runsPullRequestCode('on:\n  merge_group:\n'), true);
    assert.equal(runsPullRequestCode('on:\n  push:\n  workflow_dispatch:\n'), false);
  });

  it('runs every job on a GitHub-hosted runner, named by an allowed label', () => {
    for (const [name, text] of pullRequestRuns) {
      assert.deepEqual(unhostedRunners(text), [], `${name}: ${REVIEWED}`);
    }
    const matrix = '  test:\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-2022, macos-15]\n    runs-on: ${{ matrix.os }}\n';
    assert.deepEqual(unhostedRunners(`jobs:\n${matrix}  b:\n    runs-on: [ubuntu-24.04, macos-latest]\n`), []);
    const risky = [
      'jobs:',
      '  a:',
      '    runs-on: self-hosted',
      '  b:',
      '    runs-on: [ubuntu-latest, gpu-box]',
      '  c:',
      '    runs-on: ubuntu-latest-big',
      '  d:',
      '    runs-on:',
      '      group: our-runners',
      '  e:',
      '    runs-on: ${{ inputs.runner }}',
      '  f:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest, build-box]',
      '    runs-on: ${{ matrix.os }}',
      '  g:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest]',
      '        include:',
      '          - os: build-box',
      '    runs-on: ${{ matrix.os }}',
      '  h:',
      '    runs-on: ${{ matrix.os }}',
    ].join('\n');
    assert.deepEqual(unhostedRunners(risky), [
      'a: self-hosted',
      'b: gpu-box',
      'c: ubuntu-latest-big',
      'd: runs-on in the block form',
      'e: ${{ inputs.runner }}',
      'f: build-box',
      'g: ${{ matrix.os }} with a matrix include',
      'h: ${{ matrix.os }} with no [..] list',
    ]);
  });

  it('calls no reusable workflow, whose runners and caches this spec cannot read', () => {
    for (const [name, text] of pullRequestRuns) {
      assert.deepEqual(reusableWorkflowCalls(text), [], `${name}: ${REVIEWED}`);
    }
    const risky = 'jobs:\n  a:\n    uses: some/repo/.github/workflows/x.yml@0123\n  b:\n    steps:\n      - uses: actions/checkout@0123\n';
    assert.deepEqual(reusableWorkflowCalls(risky), ['uses: some/repo/.github/workflows/x.yml@0123']);
  });

  it('writes no Actions cache, which a later run of main could restore', () => {
    for (const [name, text] of pullRequestRuns) {
      assert.deepEqual(cacheWrites(text), [], `${name}: ${REVIEWED}`);
    }
    const risky = [
      '      - uses: actions/cache@0123 # v4.0.0',
      '      - uses: actions/cache/save@0123',
      "      - uses: 'someone/fast-cache-action@0123'",
      '        with:',
      '          cache: npm',
      '          cache-dependency-path: package-lock.json',
      '          package-manager-cache: true',
      '          package-manager-cache: false',
      '          node-version: 22 # no cache: here',
      '    cancel-in-progress: true',
    ].join('\n');
    assert.deepEqual(cacheWrites(risky), [
      '- uses: actions/cache@0123',
      '- uses: actions/cache/save@0123',
      "- uses: 'someone/fast-cache-action@0123'",
      'cache: npm',
      'cache-dependency-path: package-lock.json',
      'package-manager-cache: true',
    ]);
  });

  it('lets setup-node cache nothing on its own: package.json names no package manager, or each step turns it off', () => {
    const manifest: unknown = JSON.parse(read('package.json'));
    if (namesPackageManager(manifest)) {
      for (const [name, text] of pullRequestRuns) {
        assert.deepEqual(setupNodeCaching(text), [], `${name}: ${REVIEWED}`);
      }
    }
    assert.equal(namesPackageManager({ name: 'x', devEngines: { runtime: { name: 'node' } } }), false);
    assert.equal(namesPackageManager({ packageManager: 'npm@11.0.0' }), true);
    assert.equal(namesPackageManager({ devEngines: { packageManager: { name: 'npm' } } }), true);
    assert.equal(namesPackageManager([]), true);
    const steps = [
      '      - uses: actions/setup-node@0123 # v5.0.0',
      '        with:',
      '          node-version: 22',
      '      - run: npm ci',
      '      - name: node, uncached',
      '        uses: actions/setup-node@0123',
      '        with:',
      '          package-manager-cache: false',
    ].join('\n');
    assert.deepEqual(setupNodeCaching(steps), ['- uses: actions/setup-node@0123']);
  });
});

describe('codeql.yml', () => {
  const codeql = workflows.get('codeql.yml') ?? '';

  it('scans each pull request that changes code, each push to main, weekly and by hand', () => {
    const trigger = /^on:\n {2}push:\n {4}branches: \[main\]\n(?: {2}#.*\n)* {2}pull_request:\n {4}paths-ignore:\n {6}- '\*\*\/\*\.md'\n {6}- 'docs\/\*\*'\n {2}schedule:\n {4}- cron: '[\d* ]+'\n {2}workflow_dispatch:\n/m;
    assert.match(codeql, trigger);
  });

  it('filters only the pull request trigger, so every push to main is still scanned', () => {
    const push = /^ {2}push:\n((?: {4}.*\n)+)/m.exec(codeql)?.[1] ?? '';
    assert.doesNotMatch(push, /paths/);
    assert.equal(codeql.match(/paths-ignore:/g)?.length, 2, 'one for the pull request trigger, one for the dist');
  });

  it('scans the TypeScript with the security-extended queries and uploads with a job-scoped write token', () => {
    assert.match(codeql, /^ {4}permissions:\n {6}contents: read\n {6}security-events: write\n/m);
    assert.match(codeql, /^ {10}languages: javascript-typescript$/m);
    assert.match(codeql, /^ {10}build-mode: none$/m);
    assert.match(codeql, /^ {10}queries: security-extended$/m);
    assert.match(codeql, /^ {10}category: \/language:javascript-typescript$/m);
    const init = /github\/codeql-action\/init@([0-9a-f]{40})/.exec(codeql)?.[1];
    assert.ok(init !== undefined && codeql.includes(`github/codeql-action/analyze@${init}`), 'init and analyze run the same release');
  });

  it('skips the compiled dist, which would report each finding of the source twice', () => {
    assert.match(codeql, /^ {12}paths-ignore:\n {14}- plugins\/teamrig\/dist$/m);
  });

  it('cancels only an older pull request scan, never a scan of main', () => {
    assert.match(codeql, /^concurrency:\n {2}group: codeql-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/m);
  });

  it('stops after at most 20 minutes', () => {
    const minutes = /^ {4}timeout-minutes: (\d+)$/m.exec(codeql)?.[1];
    assert.ok(minutes !== undefined && Number(minutes) <= 20, `timeout-minutes: ${minutes}`);
  });
});

describe('dependabot.yml', () => {
  const dependabot = read('.github/dependabot.yml');
  const updates = new Map(
    dependabot
      .split(/^(?= {2}- package-ecosystem: )/m)
      .slice(1)
      .map((block) => [/^ {2}- package-ecosystem: (\S+)$/m.exec(block)?.[1] ?? '', block]),
  );

  it('proposes npm and GitHub Actions updates', () => {
    assert.match(dependabot, /^version: 2$/m);
    assert.deepEqual([...updates.keys()].sort(), ['github-actions', 'npm']);
  });

  it('proposes no release younger than 14 days, weekly, in one grouped pull request per ecosystem', () => {
    for (const [ecosystem, block] of updates) {
      assert.match(block, /^ {4}directory: \/$/m, ecosystem);
      assert.match(block, /^ {6}interval: weekly$/m, ecosystem);
      const days = /^ {4}cooldown:\n {6}default-days: (\d+)$/m.exec(block)?.[1];
      assert.ok(days !== undefined && Number(days) >= 14, `${ecosystem} cooldown: ${days}`);
      assert.match(block, /^ {4}groups:\n {6}[\w-]+:\n {8}patterns: \['\*'\]$/m, ecosystem);
    }
  });
});

describe('SECURITY.md', () => {
  it('routes a vulnerability report to a private advisory, not a public issue', () => {
    const policy = read('SECURITY.md');
    assert.ok(policy.includes('](https://github.com/GeneralA6/teamrig/security/advisories/new)'));
    assert.match(policy, /never in a public issue/);
  });
});
