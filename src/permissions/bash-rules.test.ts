import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MemoryFiles } from '../testing/memory-files.ts';
import { anyBashRuleMatches, bashPatternOf, managedSettingsFile, readBashAskDeny, ruleSettingsFiles } from './bash-rules.ts';

const CLAUDE = join('/', 'u', '.claude');
const PROJECT = join('/', 'work', 'app');
const USER = join(CLAUDE, 'settings.json');
const SHARED = join(PROJECT, '.claude', 'settings.json');
const LOCAL = join(PROJECT, '.claude', 'settings.local.json');

describe('bash rules', () => {
  it('reads a Bash rule as its pattern, the bare tool as any line, and no other tool', () => {
    const cases: readonly (readonly [string, string | undefined])[] = [
      ['Bash(git commit --no-verify:*)', 'git commit --no-verify:*'],
      [' Bash(npm run build) ', 'npm run build'],
      ['Bash', '*'],
      ['Bash()', '*'],
      ['Bash(*)', '*'],
      ['Read(~/.ssh/id_*)', undefined],
      ['PowerShell(git commit:*)', undefined],
      ['Bashful(x)', undefined],
    ];
    for (const [rule, pattern] of cases) {
      assert.equal(bashPatternOf(rule), pattern, rule);
    }
  });

  it('matches a prefix rule on the line as sent, and not once a trailer sits between its words: why the hook reads it first', () => {
    const deny = ['Bash(git commit --no-verify:*)'];
    assert.equal(anyBashRuleMatches(deny, 'git commit --no-verify -m x'), true);
    assert.equal(anyBashRuleMatches(deny, "git commit --trailer 'Made-with: teamrig 1.2.3' --no-verify -m x"), false);
  });

  it('matches loosely: a wildcard anywhere, an exact line, the bare tool, and each command of a compound line', () => {
    const line = 'git commit -s -m fix && git push origin main';
    assert.equal(anyBashRuleMatches(['Bash(git * main)'], line), true);
    assert.equal(anyBashRuleMatches(['Bash(git push:*)'], line), true);
    assert.equal(anyBashRuleMatches(['Bash'], line), true);
    assert.equal(anyBashRuleMatches(['Bash(git commit -s -m fix)'], 'git commit -s -m fix'), true);
    assert.equal(anyBashRuleMatches(['Bash(git commit -s -m fix)'], 'git commit -s -m fix2'), false);
    assert.equal(anyBashRuleMatches(['Bash(rm:*)', 'Read(//**)'], line), false);
    assert.equal(anyBashRuleMatches([], line), false);
  });

  it('holds a rule\'s other characters literally, never as regex', () => {
    assert.equal(anyBashRuleMatches(['Bash(git commit -m (a|b).)'], 'git commit -m (a|b).'), true);
    assert.equal(anyBashRuleMatches(['Bash(git commit -m a.)'], 'git commit -m ab'), false);
  });

  it('names the managed settings file of each platform, then the user, then each project folder once', () => {
    assert.equal(managedSettingsFile('win32'), String.raw`C:\Program Files\ClaudeCode\managed-settings.json`);
    assert.equal(managedSettingsFile('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
    assert.equal(managedSettingsFile('linux'), '/etc/claude-code/managed-settings.json');
    assert.deepEqual(ruleSettingsFiles(CLAUDE, [PROJECT, PROJECT], 'linux'), ['/etc/claude-code/managed-settings.json', USER, SHARED, LOCAL]);
  });

  it('reads the ask and deny rules of the Bash tool from every file there, a missing one adding none', async () => {
    const files = new MemoryFiles({
      [USER]: JSON.stringify({ permissions: { allow: ['Bash(git commit:*)'], deny: ['Bash(git commit --no-verify:*)', 'Read(~/.ssh/id_*)'] } }),
      [LOCAL]: JSON.stringify({ permissions: { ask: ['Bash(git commit --amend:*)', 7] } }),
    });
    assert.deepEqual(await readBashAskDeny(files, [USER, SHARED, LOCAL]), { kind: 'rules', rules: ['Bash(git commit --no-verify:*)', 'Bash(git commit --amend:*)'] });
    assert.deepEqual(await readBashAskDeny(new MemoryFiles(), [USER]), { kind: 'rules', rules: [] });
  });

  it('reads a settings file that is not a JSON object as unreadable, so a caller knows its rules are unknown', async () => {
    const files = new MemoryFiles({ [USER]: '{"permissions": {}}', [SHARED]: '{ not json' });
    assert.deepEqual(await readBashAskDeny(files, [USER, SHARED]), { kind: 'unreadable', path: SHARED });
  });
});
