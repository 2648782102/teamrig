import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isRecord, recordField, type JsonRecord } from '../core/guards.ts';
import { stampTrailer } from '../core/stamp.ts';
import { APP, CLAUDE_SESSION, CliHarness, TEAM, TEAM_HOME, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakeMergeGit } from '../testing/fake-merge-git.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { EXIT } from './runtime.ts';

const ASKS_OFF: JsonRecord = { ...TEAM, prompts: { hookAsks: 'refuse' } };
const ANSWERS_LOG = join(TEAM_HOME, 'state', 'prompt-answers.jsonl');
const HOOK = ['hook', 'route-allow'];
const NOTHING = { code: EXIT.ok, stdout: [], stderr: [] };
/** A token shape the secret guard knows, built here so no token sits in the source. */
const TOKEN = ['gh', 'p_', 'a1'.repeat(18)].join('');

function call(command: string, fields: JsonRecord = {}): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: CLAUDE_SESSION, cwd: APP, tool_name: 'Bash', tool_input: { command }, ...fields });
}

/** The PreToolUse answer the hook printed, or undefined. */
function outputOf(result: CliResult): JsonRecord | undefined {
  const [line] = result.stdout;
  const parsed: unknown = line === undefined ? undefined : JSON.parse(line);
  return isRecord(parsed) ? recordField(parsed, 'hookSpecificOutput') : undefined;
}

/** The permission decision of a PreToolUse answer the hook printed, or undefined. */
function decisionOf(result: CliResult): unknown {
  return outputOf(result)?.['permissionDecision'];
}

/** A team session's tab, the only one whose commits take the trailer. */
const SESSION = { TEAMRIG_SESSION: 'alpha' };
const STAMPED_COMMIT = `git -C /w commit --trailer '${stampTrailer()}' -s -m fix`;
/** The person's own Claude Code settings, whose ask and deny rules the trailer hook reads. */
const USER_SETTINGS = join(USER_HOME, '.claude', 'settings.json');

/** The prompt answers the hook logged, oldest first. */
async function answersOf(kit: CliHarness): Promise<unknown[]> {
  const text = (await kit.files.read(ANSWERS_LOG)) ?? '';
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('hook route-allow', () => {
  it("allows a sanctioned route's line before any permission check, logging only its route", async () => {
    const kit = new CliHarness(ASKS_OFF);
    const result = await kit.run(HOOK, { stdin: call('teamrig merge --session alpha'), env: { TEAMRIG_SESSION: 'alpha' } });
    assert.equal(result.code, EXIT.ok);
    assert.deepEqual(result.stderr, []);
    assert.equal(decisionOf(result), 'allow');
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('git -C /w commit -s -m fix') })), 'allow');
    assert.deepEqual(await answersOf(kit), [
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: 'alpha', claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'route', route: 'merge', command: null },
      { v: 1, at: '2030-01-08T10:00:00.000Z', session: null, claudeSession: CLAUDE_SESSION, tool: 'Bash', event: 'PreToolUse', answer: 'route', route: 'git-commit', command: null },
    ]);
  });

  it('leaves a push and the register commands to the permission check, even where they are routes', async () => {
    const kit = new CliHarness(ASKS_OFF);
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--session', 'alpha']);
    const git: RunOptions['git'] = {
      branch: () => 'dev',
      head: () => undefined,
      pushTarget: () => undefined,
      config: (_dir, key) => (key === 'remote.origin.url' ? { kind: 'set', value: 'u' } : { kind: 'unset' }),
    };
    const env = { TEAMRIG_SESSION: 'alpha' };
    assert.deepEqual(await kit.run(HOOK, { stdin: call('git push -u origin t1-x'), env, git }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig list --session alpha'), env }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });

  it("stays out when a guard asks about or refuses the route's line, so that guard answers it", async () => {
    const kit = new CliHarness(ASKS_OFF);
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('git -C /w/.git/other commit -s -m fix') })), 'allow');
    assert.deepEqual(await kit.run(HOOK, { stdin: call('git -C /w/.git/local-ci commit -s -m fix') }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call(`git commit -s -m ${TOKEN}`) }), NOTHING);
    assert.equal((await answersOf(kit)).length, 1);
  });

  it('prints nothing for another line, another tool or input that is not a hook payload', async () => {
    const kit = new CliHarness(ASKS_OFF);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('rm -rf x') }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha', { tool_name: 'PowerShell' }) }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('./teamrig merge --session alpha') }), NOTHING);
    assert.deepEqual(await kit.run(HOOK, { stdin: 'not json' }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });

  it('prints nothing with asks on, with the switch off, or with the config missing or broken, and answers by default (T3356)', async () => {
    const route = call('teamrig merge --session alpha');
    assert.deepEqual(await new CliHarness().run(HOOK, { stdin: route }), await new CliHarness(ASKS_OFF).run(HOOK, { stdin: route }));
    const quiet = [
      new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask', routeAllow: 'on' } }),
      new CliHarness({ ...TEAM, prompts: { hookAsks: 'refuse', routeAllow: 'off' } }),
      new CliHarness(null),
      new CliHarness('{ not json'),
    ];
    for (const kit of quiet) {
      assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha') }), NOTHING);
    }
  });

  it("gives a team session's commit the Made-with trailer inside the route's allow, its other fields kept (T3270)", async () => {
    const kit = new CliHarness(ASKS_OFF);
    const result = await kit.run(HOOK, { stdin: call('git -C /w commit -s -m fix', { tool_input: { command: 'git -C /w commit -s -m fix', description: 'Commit' } }), env: SESSION });
    assert.equal(decisionOf(result), 'allow');
    assert.deepEqual(outputOf(result)?.['updatedInput'], { command: STAMPED_COMMIT, description: 'Commit' });
  });

  it('gives the trailer as a rewrite alone, with no decision, where no allow comes: asks on, a guard asking (T3270)', async () => {
    const rewrite = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: STAMPED_COMMIT } } };
    const asksOn = new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask' } });
    const result = await asksOn.run(HOOK, { stdin: call('git -C /w commit -s -m fix'), env: SESSION });
    assert.deepEqual([result.code, result.stdout.map((line): unknown => JSON.parse(line))], [EXIT.ok, [rewrite]]);
    const guarded = await new CliHarness(ASKS_OFF).run(HOOK, { stdin: call('git -C /w/.git/local-ci commit -s -m fix'), env: SESSION });
    assert.equal(decisionOf(guarded), undefined);
    assert.deepEqual(outputOf(guarded)?.['updatedInput'], { command: `git -C /w/.git/local-ci commit --trailer '${stampTrailer()}' -s -m fix` });
  });

  it('adds no trailer with the stamp off, outside a team session, on a git older than 2.32 or for another tool (T3270)', async () => {
    const commit = call('git -C /w commit -s -m fix');
    const old = new FakeMergeGit();
    old.versionIs = '2.31.0';
    const runs = [
      await new CliHarness({ ...ASKS_OFF, github: { stamp: false } }).run(HOOK, { stdin: commit, env: SESSION }),
      await new CliHarness(ASKS_OFF).run(HOOK, { stdin: commit }),
      await new CliHarness(ASKS_OFF).run(HOOK, { stdin: commit, env: SESSION, mergeGit: old }),
    ];
    for (const result of runs) {
      assert.equal(decisionOf(result), 'allow');
      assert.equal(outputOf(result)?.['updatedInput'], undefined);
    }
    assert.deepEqual(await new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask' } }).run(HOOK, { stdin: call('git commit -m y', { tool_name: 'PowerShell' }), env: SESSION }), NOTHING);
  });

  it("leaves a commit a person's Bash ask or deny rule could match as sent, so a prefix rule still holds, on both paths (T3270)", async () => {
    const commit = call('git commit -s -m fix');
    const denies = new CliHarness(ASKS_OFF);
    await denies.files.write(USER_SETTINGS, JSON.stringify({ permissions: { deny: ['Bash(git commit -s:*)'] } }));
    const allowed = await denies.run(HOOK, { stdin: commit, env: SESSION });
    assert.equal(decisionOf(allowed), 'allow');
    assert.equal(outputOf(allowed)?.['updatedInput'], undefined);
    const asks = new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask' } });
    await asks.files.write(join(APP, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { ask: ['Bash(git commit -s:*)'] } }));
    assert.deepEqual(await asks.run(HOOK, { stdin: commit, env: SESSION }), NOTHING);
  });

  it('adds no trailer while a settings file cannot be read, and still adds it past a rule on another line (T3270)', async () => {
    const broken = new CliHarness({ ...TEAM, prompts: { hookAsks: 'ask' } });
    await broken.files.write(USER_SETTINGS, '{ not json');
    assert.deepEqual(await broken.run(HOOK, { stdin: call('git -C /w commit -s -m fix'), env: SESSION }), NOTHING);
    const other = new CliHarness(ASKS_OFF);
    await other.files.write(USER_SETTINGS, JSON.stringify({ permissions: { deny: ['Bash(rm:*)', 'Read(~/.ssh/id_*)'], ask: ['Bash(git push:*)'] } }));
    assert.deepEqual(outputOf(await other.run(HOOK, { stdin: call('git -C /w commit -s -m fix'), env: SESSION }))?.['updatedInput'], { command: STAMPED_COMMIT });
  });

  it('reads the rules of the project the session started in, past a blank one, and leaves a call with no command alone (T3270)', async () => {
    const started = join(USER_HOME, 'started');
    const commit = call('git -C /w commit -s -m fix');
    const kit = new CliHarness(ASKS_OFF);
    await kit.files.write(join(started, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(git -C /w commit:*)'] } }));
    const held = await kit.run(HOOK, { stdin: commit, env: { ...SESSION, CLAUDE_PROJECT_DIR: started } });
    assert.equal(decisionOf(held), 'allow');
    assert.equal(outputOf(held)?.['updatedInput'], undefined);
    assert.deepEqual(outputOf(await kit.run(HOOK, { stdin: commit, env: { ...SESSION, CLAUDE_PROJECT_DIR: ' ' } }))?.['updatedInput'], { command: STAMPED_COMMIT });
    for (const toolInput of [{}, 'git commit -m y']) {
      assert.equal(outputOf(await kit.run(HOOK, { stdin: call('', { tool_input: toolInput }), env: SESSION }))?.['updatedInput'], undefined);
    }
  });

  it('still allows when the log cannot be written', async () => {
    const kit = new CliHarness(ASKS_OFF);
    const files = new FaultyFiles(kit.files).fail('append', ANSWERS_LOG, systemError('ENOSPC'));
    assert.equal(decisionOf(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha'), files })), 'allow');
    assert.deepEqual(await answersOf(kit), []);
  });

  it('prints nothing and exits ok when building its answer throws, so it never blocks the call', async () => {
    const kit = new CliHarness(ASKS_OFF);
    // A clock that gives no time: the allow's log line cannot carry a date, and that error reaches the hook itself.
    kit.clock.advance(Number.NaN);
    assert.deepEqual(await kit.run(HOOK, { stdin: call('teamrig merge --session alpha') }), NOTHING);
    assert.deepEqual(await answersOf(kit), []);
  });
});
