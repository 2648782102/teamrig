import type { JsonRecord } from '../core/guards.ts';
import { STAMP_TRAILER_KEY, stampTrailer } from '../core/stamp.ts';

/**
 * The commit trailer hook (T3270, route B of tasks/T3270/route.md): a team session's own `git commit`, run through the
 * Bash tool, gains `--trailer 'Made-with: teamrig <version>'`, so its commit carries the stamp as ship.ts commits do
 * (core/stamp.ts). Claude Code's own `Co-Authored-By` line is the message's text and stays as written; git adds the
 * trailer to the same trailer block. The rewrite is the one fixed option put right after the `commit` word, read from
 * a strict prefix of the line, so the message, a heredoc and any command after it stay exactly as they were.
 */

/** The first git with `git commit --trailer` (2.32.0); an older git refuses the option, so its commits are left alone. */
const TRAILER_GIT = { major: 2, minor: 32 } as const;

/** Whether `version`, such as `2.43.0`, is a git that takes `commit --trailer`; false when git could not tell. */
export function gitTakesTrailer(version: string | undefined): boolean {
  const match = version === undefined ? null : /^(\d+)\.(\d+)/u.exec(version);
  if (match === null) {
    return false;
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > TRAILER_GIT.major || (major === TRAILER_GIT.major && minor >= TRAILER_GIT.minor);
}

/**
 * One `-C` folder word whose bounds the shell reads as written: plain characters with nothing the shell expands or
 * splits on, a single-quoted run, or a double-quoted run with nothing the shell expands inside it.
 */
const FOLDER_WORD = String.raw`(?:[^\s'"\\$\x60;&|<>(){}*?\[\]#~!]+|'[^'\n]*'|"[^"\\$\x60!\n]*")`;

/**
 * `git [-C <folder>]... commit` at the very start of a line, `commit` ending at a space, a tab, a line end or the end.
 * Nothing before `git` (no variable, `env`, `cd` or other command), so the commit is the line's first command.
 */
const COMMIT_START = new RegExp(String.raw`^[ \t]*git(?:[ \t]+-C[ \t]+${FOLDER_WORD})*[ \t]+commit(?=[ \t\n]|$)`, 'u');

/** A `Made-with:` trailer already on the line, in any case: the commit is stamped, and a second would repeat it. */
const STAMPED = new RegExp(`${STAMP_TRAILER_KEY}:`, 'iu');

/**
 * An `--amend` word anywhere on the line: the commit it rewrites may be another author's (an outside pull request landed
 * with credit) or stamped already in its message, which the line does not show, so an amend is left as sent.
 */
const AMEND = /(?:^|\s)--amend(?=[\s=]|$)/u;

/** The trailer text the option carries: only letters, digits, spaces and `.:-`, so single quotes hold it literally. */
const TRAILER_TEXT = /^[\w .:-]+$/u;

/**
 * `command` with `--trailer '<trailer>'` right after its leading `git ... commit`; undefined when the line does not
 * start with a git commit, amends one, already names a `Made-with:` trailer, or the trailer is not plain text.
 */
export function withCommitTrailer(command: string, trailer: string = stampTrailer()): string | undefined {
  const start = COMMIT_START.exec(command);
  if (start === null || AMEND.test(command) || STAMPED.test(command) || !TRAILER_TEXT.test(trailer)) {
    return undefined;
  }
  const at = start[0].length;
  return `${command.slice(0, at)} --trailer '${trailer}'${command.slice(at)}`;
}

/**
 * The tool input the rewrite runs: the call's own input with only its command replaced, so the description, timeout
 * and every other field Claude Code sent stay.
 */
export function trailerInput(toolInput: JsonRecord, command: string): JsonRecord {
  return { ...toolInput, command };
}

/** The hook's stdout for a rewrite alone: the new input and no permission decision, so the usual check still runs. */
export function commitTrailerOutput(updatedInput: JsonRecord): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } });
}
