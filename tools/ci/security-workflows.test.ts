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

/** A line of a workflow file as this spec reads it. */
interface WorkflowLine {
  /** The line as written, its trailing carriage return dropped. */
  readonly source: string;
  /** The line with its comment cut, or '' for a line of a block scalar's text. */
  readonly kept: string;
  /** Whether the line is the text of a block scalar (`run: |`), which no check reads as keys. */
  readonly body: boolean;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
/** The indent of a line's content: past a list item's `- `. */
const contentIndentOf = (line: string): number => indentOf(line) + (/^\s*- /.test(line) ? 2 : 0);
/** Where a line's comment starts, as GitHub reads it: a `#` at the line's start or after a space; -1 for none. */
const commentAt = (line: string): number => line.search(/(?:^|\s)#/);

/**
 * The one line shape the checks read: an indent of two-space steps, then a plain key (with a list item's `- ` before
 * it or not) and its value, or a list item's bare value. Groups: 1 indent, 2 the `- `, 3 key, 4 its value, 5 an item.
 */
const SHAPE = /^((?: {2})*)(- )?(?:([A-Za-z_][\w-]*):(?: (.*))?|(.+))$/;
/** A block scalar's header (`|`, `>-`, `|+`): the deeper lines below it are its text. */
const BLOCK_SCALAR = /^[|>][-+]?$/;
/** The keys whose value may be a block scalar: a step's script, and CodeQL's config, neither read as workflow keys. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['run', 'config']);
/** Printable ASCII only: no tab, lone carriage return or Unicode line break can split a line where YAML would. */
const PRINTABLE = /^[\x20-\x7e]*$/;

/** The scalar a line holds: a key's value or a list item's, '' for a key that opens a block. */
const scalarOf = (kept: string): string => {
  const parts = SHAPE.exec(kept);
  return (parts?.[4] ?? parts?.[5] ?? '').trim();
};

/** Each line of a workflow, its comment cut and a block scalar's text marked, so no check reads a script as keys. */
function readLines(text: string): readonly WorkflowLine[] {
  let textOver: number | undefined;
  return text.split('\n').map((line) => {
    const source = line.replace(/\r$/, '');
    if (textOver !== undefined && (source.trim() === '' || indentOf(source) > textOver)) return { source, kept: '', body: true };
    textOver = undefined;
    const at = commentAt(source);
    const kept = (at === -1 ? source : source.slice(0, at)).trimEnd();
    if (BLOCK_SCALAR.test(scalarOf(kept))) textOver = contentIndentOf(kept);
    return { source, kept, body: false };
  });
}

/** A workflow's lines as its keys read: comments cut, and '' for each line of a block scalar's text. */
const structuralLines = (text: string): readonly string[] => readLines(text).map(({ kept }) => kept);

/** Why a plain value is outside the shape, or undefined when it is in it. */
function valueFault(value: string): string | undefined {
  if (value === '') return undefined;
  if (value.startsWith('"')) return /^"[^"]*"$/.test(value) ? undefined : 'a double-quoted value that does not end on its line';
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? undefined : 'a single-quoted value that does not end on its line';
  if (value.startsWith('[')) return /^\[[^[\]]*\]$/.test(value) ? undefined : 'a flow list that nests or does not end on its line';
  if (/^(?:[&*!%@`?:,#|>]|-(?: |$))/.test(value)) return 'an anchor, alias, tag, block scalar or other YAML marker';
  if (/:(?: |$)/.test(value)) return 'a `: ` inside a plain value';
  return undefined;
}

/** Why one uncommented line, outside a block scalar's text, is outside the shape; undefined when it is in it. */
function structureFault(source: string, kept: string, room: number): string | undefined {
  const comment = commentAt(source);
  if (comment !== -1 && /['"]/.test(source.slice(0, comment))) return 'a quote before a ` #`, which may sit inside a quoted value';
  if (kept.includes('\\')) return 'a backslash, which may be a YAML escape';
  if (/[{}]/.test(kept.replace(/\$\{\{.*?\}\}/g, ''))) return 'a flow map';
  const parts = SHAPE.exec(kept);
  const [, indent = '', dash, key, value, item] = parts ?? [];
  if (parts === null || (key === undefined && dash === undefined)) return 'not a plain key or a list item at a two-space indent';
  if (indent.length > room) return `an indent past ${room}`;
  const scalar = (value ?? item ?? '').trim();
  if (BLOCK_SCALAR.test(scalar)) return key !== undefined && TEXT_KEYS.has(key) ? undefined : 'a block scalar outside run: and config:';
  return valueFault(scalar);
}

/**
 * The lines of a workflow outside the one YAML shape the checks below read, as `<line>: <why>: <text>`. GitHub
 * accepts YAML in more forms (quoted or escaped keys, flow maps, deeper indents, anchors), each of which could carry
 * a runner, an action or a trigger past a check that reads lines; so a file in any other form fails, and the checks
 * hold for every file that passes.
 */
function shapeFaults(text: string): readonly string[] {
  const faults: string[] = [];
  let room = 0;
  for (const [at, { source, kept, body }] of readLines(text).entries()) {
    const fault = !PRINTABLE.test(source)
      ? 'a character outside printable ASCII'
      : body || kept === ''
        ? undefined
        : structureFault(source, kept, room);
    if (fault !== undefined) faults.push(`${at + 1}: ${fault}: ${source.trim()}`);
    if (!body && kept !== '') room = contentIndentOf(kept) + (kept.endsWith(':') ? 2 : 0);
  }
  return faults;
}

const unquoted = (word: string): string => word.trim().replace(/^(['"])(.*)\1$/, '$2');
const listOf = (flow: string): readonly string[] => flow.split(',').map(unquoted);

/**
 * The events that start a workflow, from its top-level `on:` in the inline (`on: push`, `on: [push, pull_request]`),
 * list (`- push`) or map (`push:`, `pull_request: {}`) form. Undefined when it cannot be read (no `on:`, two of them,
 * a flow map, an odd indent), which a caller counts as running a pull request's code: the rules fail closed.
 */
function triggersOf(text: string): readonly string[] | undefined {
  const lines = structuralLines(text);
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
 * The mentions of an event no workflow may start on: workflow_run runs with secrets and a write token after a fork
 * pull request's run, and workflow_call runs a file under its caller's event, out of reach of the trigger reader.
 */
const forbiddenEvents = (text: string): readonly string[] =>
  [...structuralLines(text).join('\n').matchAll(/\bworkflow_(?:run|call)\b/gi)].map(([word]) => word);

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

/** The deeper lines under the first of `lines` that `opener` matches, or undefined when none does. */
function blockUnder(lines: readonly string[], opener: RegExp): readonly string[] | undefined {
  const start = lines.findIndex((line) => opener.test(line));
  if (start === -1) return undefined;
  const indent = indentOf(lines[start] ?? '');
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) <= indent) break;
    block.push(line);
  }
  return block;
}

/**
 * The runner labels one `runs-on:` value asks for. `${{ matrix.<key> }}` is read through the `<key>: [..]` list of
 * the job's own `strategy:` `matrix:`, and nowhere else in the job; any other expression, a matrix `include:` (which
 * can add a label), a matrix with no such list, the block form and `group:` come back as they are, so the label check
 * reports them.
 */
function labelsOf(value: string, job: readonly string[]): readonly string[] {
  if (value === '') return ['runs-on in the block form'];
  const matrixKey = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(value)?.[1];
  if (matrixKey !== undefined) {
    const matrix = blockUnder(blockUnder(job, /^ {4}strategy:$/i) ?? [], /^ {6}matrix:$/i) ?? [];
    if (matrix.some((line) => /^ {8}include:/i.test(line))) return [`${value} with a matrix include`];
    // A context's key reads in any case, so `OS:` and `os:` both answer matrix.os: more than one such key is unread.
    const values = matrix.flatMap((line) => new RegExp(`^ {8}${matrixKey}:(.*)$`, 'i').exec(line)?.[1] ?? []);
    const flow = values.length === 1 ? /^\s*\[(.*)\]$/.exec(values[0] ?? '')?.[1] : undefined;
    return flow === undefined ? [`${value} with no [..] list`] : listOf(flow);
  }
  const flow = /^\[(.*)\]$/.exec(value)?.[1];
  return flow === undefined ? [unquoted(value)] : listOf(flow);
}

/** Each job's runner label in a workflow that is not a GitHub-hosted one, as `<job line>: <label>`. */
function unhostedRunners(text: string): readonly string[] {
  const lines = structuralLines(text);
  return lines.flatMap((line, at) => {
    const value = /^\s+runs-on:(.*)$/i.exec(line)?.[1];
    if (value === undefined) return [];
    const job = jobAround(lines, at);
    return labelsOf(value.trim(), job)
      .filter((label) => !HOSTED.test(label))
      .map((label) => `${(job[0] ?? '').trim()} ${label}`);
  });
}

/** The job-level `uses:` lines (job keys sit at 4 once the shape rule passed): a reusable workflow, which runs unread. */
const reusableWorkflowCalls = (text: string): readonly string[] =>
  structuralLines(text).filter((line) => /^ {4}uses:/i.test(line)).map((line) => line.trim());

/**
 * The actions a pull request workflow may run, by owner/repo/path, each reviewed to write no Actions cache unasked
 * (setup-node's own caching is held off by the rule below). Any other one, a local `./` action or a `docker://` image
 * included, fails: actions/setup-go, gradle/actions/setup-gradle and astral-sh/setup-uv cache by default, with no input
 * to name.
 */
const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  'actions/checkout',
  'actions/setup-node',
  'actions/dependency-review-action',
  'github/codeql-action/init',
  'github/codeql-action/analyze',
]);

/** The `uses:` lines of a workflow whose action is not on the reviewed list. */
const unlistedActions = (text: string): readonly string[] =>
  structuralLines(text).flatMap((line) => {
    const value = /^\s*(?:- )?uses:(.*)$/i.exec(line)?.[1];
    if (value === undefined) return [];
    const [action = ''] = unquoted(value).split('@');
    return PULL_REQUEST_ACTIONS.has(action) ? [] : [line.trim()];
  });

/**
 * The lines that write an Actions cache a later run of main could restore: a caching action (actions/cache and its
 * save and restore parts, or any other whose path names a cache) or a `cache…:` input, setup-node's `cache:` too.
 * `package-manager-cache: false`, which turns setup-node's own caching off, is the one cache key let through.
 */
const cacheWrites = (text: string): readonly string[] =>
  structuralLines(text)
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
  structuralLines(text)
    .join('\n')
    .split(/^(?=\s*-\s)/m)
    .filter((step) => /\buses:\s*actions\/setup-node@/i.test(step) && !/^\s*package-manager-cache:\s*false$/m.test(step))
    .map((step) => step.trim().split('\n')[0] ?? '');

/** A 40-hex commit for the fixtures below. */
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('every workflow', () => {
  it('is there to read', () => {
    assert.ok(workflows.has('ci.yml') && workflows.has('codeql.yml'), [...workflows.keys()].join(', '));
  });

  it('is written in the one YAML shape the checks read, so no other form carries a key past them', () => {
    for (const [name, text] of workflows) {
      assert.deepEqual(shapeFaults(text), [], `${name}: ${REVIEWED}`);
    }
    const ok = [
      'on:',
      '  push:',
      '    branches: [main]',
      '  schedule:',
      "    - cron: '23 4 * * 1'",
      'jobs:',
      '  a:',
      '    if: ${{ github.event_name == \'push\' }}',
      '    runs-on: ubuntu-latest # a comment',
      '    steps:',
      '      - run: |',
      '          echo "a: {b}" # all text',
      '',
      '          "uses": x',
      '      - uses: actions/checkout@0123 # v5.0.0',
      '        with:',
      '          config: >-',
      '            x',
      '        env:',
      '          GH_TOKEN: ${{ github.token }}',
      '          NAME: "plain"',
      "          NOTE: 'it''s'",
    ].join('\r\n');
    assert.deepEqual(shapeFaults(ok), []);
    const risky: readonly (readonly [string, string])[] = [
      ['jobs:\n  a:\n    "runs-on": self-hosted\n', 'not a plain key'],
      ["jobs:\n  a:\n    'uses': ./.github/workflows/x.yml\n", 'not a plain key'],
      ['jobs:\n  a: {runs-on: self-hosted}\n', 'a flow map'],
      ['on:\n  "workflow\\x5frun":\n', 'a backslash'],
      ['jobs:\n  a:\n    name: "a\\u0023"\n', 'a backslash'],
      ["on: [push, 'a #b']\n", 'a quote before'],
      ['jobs:\n    a:\n        uses: x\n', 'an indent past 2'],
      ['jobs:\n  a:\n   runs-on: self-hosted\n', 'not a plain key'],
      ['jobs:\n  a:\n\truns-on: self-hosted\n', 'outside printable ASCII'],
      ['jobs:\n  a:\n    runs-on: x\rruns-on: self-hosted\n', 'outside printable ASCII'],
      ['jobs:\n  a:\n    runs-on: x\u2028    runs-on: self-hosted\n', 'outside printable ASCII'],
      ['jobs:\n  a:\n    runs-on: *runner\n', 'an anchor, alias'],
      ['jobs:\n  a:\n    runs-on: !!str self-hosted\n', 'an anchor, alias'],
      ['jobs:\n  a: &job\n', 'an anchor, alias'],
      ['jobs:\n  <<: *jobs\n', 'not a plain key'],
      ['---\non: push\n', 'not a plain key'],
      ['on: |\n  workflow_run\n', 'a block scalar outside'],
      ['jobs:\n  a:\n    runs-on: "self-hosted\n      x"\n', 'a double-quoted value'],
      ["jobs:\n  a:\n    runs-on: 'self-hosted\n", 'a single-quoted value'],
      ['jobs:\n  a:\n    runs-on: [ubuntu-latest,\n      self-hosted]\n', 'a flow list'],
      ['jobs:\n  a:\n    name: a: b\n', 'a `: ` inside'],
      ['jobs:\n  a:\n    ? runs-on\n', 'not a plain key'],
    ];
    for (const [text, why] of risky) {
      const faults = shapeFaults(text);
      assert.ok(faults.some((fault) => fault.includes(why)), `${JSON.stringify(text)}: ${faults.join(' | ')}`);
    }
  });

  it('reads a block scalar as text, never as keys, from its header to the first line not deeper than its key', () => {
    assert.deepEqual(structuralLines('a:\n  run: |\n    x: 1\n\n    y # z\n  b: 2 # c\n'), ['a:', '  run: |', '', '', '', '  b: 2', '']);
    assert.deepEqual(structuralLines('      - run: >-\n          x\n        with: y\n'), ['      - run: >-', '', '        with: y', '']);
  });

  it('starts on no workflow_run, which runs with secrets after a fork pull request\'s run, and no workflow_call', () => {
    for (const [name, text] of workflows) {
      assert.deepEqual(forbiddenEvents(text), [], `${name}: ${REVIEWED}`);
    }
    assert.deepEqual(forbiddenEvents('on:\n  workflow_run:\n    workflows: [ci]'), ['workflow_run']);
    assert.deepEqual(forbiddenEvents('on: [push, workflow_call]\n'), ['workflow_call']);
    assert.deepEqual(forbiddenEvents('  # never workflow_run here\n  run: |\n    echo workflow_call\n'), []);
  });

  it('pins each action to a full commit SHA with its version beside it, so a moved tag cannot change what runs', () => {
    for (const [name, text] of workflows) {
      for (const [line] of text.matchAll(/^.*\buses:.*$/gim)) {
        assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}: ${line.trim()}`);
      }
    }
  });

  it('gives the token read-only contents by default, and never runs a fork pull request with secrets', () => {
    for (const [name, text] of workflows) {
      assert.match(text, /^permissions:\n {2}contents: read\n/m, name);
      assert.doesNotMatch(text, /pull_request_target/i, name);
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
    for (const unreadable of ['name: x\n', 'on: {push: {}}\n', 'on:\njobs:\n', 'on: push\non: pull_request\n', 'on:\n    push:\n  pull_request:\n', 'on: |\n  push\n']) {
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
      '  i:',
      '    env:',
      '      os: [ubuntu-latest]',
      '    strategy:',
      '      matrix:',
      '        os: ${{ fromJSON(vars.RUNNERS) }}',
      '    runs-on: ${{ matrix.os }}',
      '  j:',
      '    strategy:',
      '      matrix: ${{ fromJSON(vars.MATRIX) }}',
      '    steps:',
      '      - run: |',
      '          os: [ubuntu-latest]',
      '    runs-on: ${{ matrix.os }}',
      '  k:',
      '    RUNS-ON: self-hosted',
      '  l:',
      '    strategy:',
      '      matrix:',
      '        OS: [build-box]',
      '        os: [ubuntu-latest]',
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
      'i: ${{ matrix.os }} with no [..] list',
      'j: ${{ matrix.os }} with no [..] list',
      'k: self-hosted',
      'l: ${{ matrix.os }} with no [..] list',
    ]);
  });

  it('calls no reusable workflow, whose runners and caches this spec cannot read', () => {
    for (const [name, text] of pullRequestRuns) {
      assert.deepEqual(reusableWorkflowCalls(text), [], `${name}: ${REVIEWED}`);
    }
    const risky = 'jobs:\n  a:\n    uses: some/repo/.github/workflows/x.yml@0123\n  b:\n    steps:\n      - uses: actions/checkout@0123\n  c:\n    Uses: x/y/.github/workflows/z.yml@0123\n';
    assert.deepEqual(reusableWorkflowCalls(risky), ['uses: some/repo/.github/workflows/x.yml@0123', 'Uses: x/y/.github/workflows/z.yml@0123']);
  });

  it('uses only the actions reviewed to write no cache unasked', () => {
    for (const [name, text] of pullRequestRuns) {
      assert.deepEqual(unlistedActions(text), [], `${name}: ${REVIEWED}`);
    }
    const steps = [
      `      - uses: actions/checkout@${SHA} # v5.0.0`,
      `      - uses: 'github/codeql-action/init@${SHA}'`,
      `      - uses: actions/setup-go@${SHA} # v5.0.0`,
      `      - name: gradle`,
      `        uses: gradle/actions/setup-gradle@${SHA}`,
      `      - uses: astral-sh/setup-uv@${SHA}`,
      '      - uses: ./.github/actions/local',
      '      - uses: docker://alpine:3',
      `      - uses: actions/checkout/sub@${SHA}`,
      `      - uses: Actions/Checkout@${SHA}`,
      '    uses: org/repo/.github/workflows/x.yml@main',
    ].join('\n');
    assert.deepEqual(unlistedActions(steps), [
      `- uses: actions/setup-go@${SHA}`,
      `uses: gradle/actions/setup-gradle@${SHA}`,
      `- uses: astral-sh/setup-uv@${SHA}`,
      '- uses: ./.github/actions/local',
      '- uses: docker://alpine:3',
      `- uses: actions/checkout/sub@${SHA}`,
      `- uses: Actions/Checkout@${SHA}`,
      'uses: org/repo/.github/workflows/x.yml@main',
    ]);
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

describe("the security review's probes past the first spec (T4687)", () => {
  /** Each probe, and the rule that now stops it; a probe aimed past another rule must pass the shape rule first. */
  const probes: readonly (readonly [string, string, (text: string) => readonly string[]])[] = [
    ['a # in quotes hides workflow_run', `on: {push: {branches: ['a #b']}, workflow_run: {workflows: [ci], types: [completed]}}\n`, shapeFaults],
    ['an escaped workflow_run', 'on:\n  "workflow\\x5frun":\n    workflows: [ci]\n', shapeFaults],
    ['an escaped pull_request_target', 'on:\n  "pull\\x5frequest_target": {}\n', shapeFaults],
    ['a quoted runs-on', 'on: pull_request\njobs:\n  a:\n    "runs-on": self-hosted\n', shapeFaults],
    ['a flow-map job', 'on: pull_request\njobs:\n  a: {runs-on: self-hosted, steps: [{run: x}]}\n', shapeFaults],
    ['a reusable call at a 4-space job indent', `on: pull_request\njobs:\n    a:\n        uses: org/repo/.github/workflows/x.yml@${SHA} # v1.0.0\n`, shapeFaults],
    ['a quoted local uses', 'on: pull_request\njobs:\n  a:\n    "uses": ./.github/workflows/x.yml\n', shapeFaults],
    ['a quoted cache uses', `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - "uses": actions/cache/save@${SHA}\n        with: {path: x, key: y}\n`, shapeFaults],
    ['a quoted cache input', `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-python@${SHA} # v5.0.0\n        with:\n          "cache": pip\n`, shapeFaults],
    ['a matrix decoy in a script', 'on: pull_request\njobs:\n  a:\n    steps:\n      - run: |\n          os: [ubuntu-latest]\n    strategy:\n      matrix:\n        os: ${{ fromJSON(vars.RUNNERS) }}\n    runs-on: ${{ matrix.os }}\n', unhostedRunners],
    ['an action that caches by default', `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-go@${SHA} # v5.0.0\n        with:\n          go-version: '1.23'\n`, unlistedActions],
    ['a workflow_call callee', 'on: workflow_call\njobs:\n  a:\n    runs-on: self-hosted\n', forbiddenEvents],
  ];

  for (const [name, text, rule] of probes) {
    it(`stops ${name}`, () => {
      if (rule !== shapeFaults) assert.deepEqual(shapeFaults(text), [], 'the probe is in the shape, so the rule below is the one that stops it');
      assert.notDeepEqual(rule(text), [], text);
    });
  }
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
