import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stampTrailer } from '../core/stamp.ts';
import { commitTrailerOutput, gitTakesTrailer, trailerInput, withCommitTrailer } from './commit-trailer.ts';

const TRAILER = 'Made-with: teamrig 1.2.3';
const OPTION = `--trailer '${TRAILER}'`;

describe('commit trailer', () => {
  it('puts the trailer right after the commit word of a leading git commit, the rest as written', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['git commit -m fix', `git commit ${OPTION} -m fix`],
      ['git commit -s', `git commit ${OPTION} -s`],
      ['git commit', `git commit ${OPTION}`],
      ["git commit -s -F - <<'EOF'\nfix: a thing\n\nCo-Authored-By: someone\nEOF", `git commit ${OPTION} -s -F - <<'EOF'\nfix: a thing\n\nCo-Authored-By: someone\nEOF`],
      ['  git -C /w commit -s -m fix', `  git -C /w commit ${OPTION} -s -m fix`],
      ["git -C 'C:/a b' commit -m x", `git -C 'C:/a b' commit ${OPTION} -m x`],
      ['git -C "C:/a b" commit', `git -C "C:/a b" commit ${OPTION}`],
      ['git -C /w -C sub commit -m x && git log -1', `git -C /w -C sub commit ${OPTION} -m x && git log -1`],
      ['git\tcommit\t-m x', `git\tcommit ${OPTION}\t-m x`],
    ];
    for (const [line, rewritten] of cases) {
      assert.equal(withCommitTrailer(line, TRAILER), rewritten, line);
    }
  });

  it('leaves a line whose first command is not a git commit, or that names its own Made-with trailer', () => {
    const lines = [
      'git add x && git commit -m y',
      'cd x && git commit -m y',
      'env git commit -m y',
      'GIT_DIR=x git commit -m y',
      'git -c user.name=x commit -m y',
      'git commit-tree HEAD^{tree}',
      'git -C $W commit -m y',
      'git -C "$W" commit -m y',
      'git -C `pwd` commit -m y',
      "git commit -m y --trailer 'made-with: something'",
      'git status',
      'echo git commit',
    ];
    for (const line of lines) {
      assert.equal(withCommitTrailer(line, TRAILER), undefined, line);
    }
  });

  it("leaves an amend alone, whose commit may be another author's or stamped in its message already (T3270)", () => {
    const lines = ['git commit --amend --no-edit', 'git -C /w commit -s --amend -m y', 'git commit --amend', 'git commit --amend=x'];
    for (const line of lines) {
      assert.equal(withCommitTrailer(line, TRAILER), undefined, line);
    }
    assert.equal(withCommitTrailer('git commit -m --amended', TRAILER), `git commit ${OPTION} -m --amended`);
  });

  it('adds only a plain trailer, so the single quotes hold it literally', () => {
    assert.equal(withCommitTrailer('git commit -m y', "Made-with: x'; rm -rf y; '"), undefined);
    assert.equal(withCommitTrailer('git commit -m y', 'Made-with: $(id)'), undefined);
    assert.equal(withCommitTrailer('git commit -m y'), `git commit --trailer '${stampTrailer()}' -m y`);
  });

  it('takes the trailer from git 2.32 on, never when git could not tell', () => {
    const cases: readonly (readonly [string | undefined, boolean])[] = [
      ['2.31.9', false],
      ['1.40.0', false],
      ['2.32.0', true],
      ['2.51.0.windows.1', true],
      ['3.0', true],
      ['not a version', false],
      [undefined, false],
    ];
    for (const [version, takes] of cases) {
      assert.equal(gitTakesTrailer(version), takes, String(version));
    }
  });

  it("runs the call's own input with only its command replaced, and answers with no permission decision", () => {
    const input = trailerInput({ command: 'git commit -m y', description: 'Commit', timeout: 5000 }, 'git commit --trailer x -m y');
    assert.deepEqual(input, { command: 'git commit --trailer x -m y', description: 'Commit', timeout: 5000 });
    assert.deepEqual(JSON.parse(commitTrailerOutput(input)), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: input } });
  });
});
