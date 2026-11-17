import { join } from 'node:path';
import { ENV, type Env, resolveKitHome, taskFolder } from '../../src/core/home.ts';
import { taskOfBranch } from './approval.ts';

/**
 * The text of the pull request a merge opens (T3420): What, Why and Reach, as `.github/pull_request_template.md`
 * asks, so a ship-made pull request says what a hand-opened one does. It comes from `--note-file`, else from the
 * `pr.md` in the folder of the branch's task (`teamrig files T<id>`), where a session writes it before asking for
 * approval. A merge with no such text, or one whose Reach is empty, is refused before any GitHub call.
 */

/** The file in a task's folder that holds its pull request text. */
export const PULL_TEXT_FILE = 'pr.md';

/** Where the pull request text was looked for and why it cannot open one, or the text itself. */
export type PullText = { readonly kind: 'found'; readonly text: string } | { readonly kind: 'refused'; readonly reason: string };

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const REACH_LINE = /^Reach:[ \t]*(.*)$/m;
const REACH_HEADING = /^##[ \t]+Reach[ \t]*$/m;
const NEXT_HEADING = /^#{1,2}[ \t]/m;

/**
 * The Reach the text states, trimmed: a `Reach:` line, or the body of its `## Reach` section up to the next heading,
 * the template's `<!-- -->` hints left out. Null when neither says anything.
 */
export function reachOf(text: string): string | null {
  const bare = text.replace(HTML_COMMENT, '');
  const line = REACH_LINE.exec(bare)?.[1]?.trim() ?? '';
  if (line !== '') return line;
  const heading = REACH_HEADING.exec(bare);
  if (heading === null) return null;
  const rest = bare.slice(heading.index + heading[0].length);
  const next = NEXT_HEADING.exec(rest);
  const section = (next === null ? rest : rest.slice(0, next.index)).trim();
  return section === '' ? null : section;
}

/** The task folder's pull request text for `branch` in `team`, or null when the branch names no task or no team is set. */
export function taskPullTextFile(env: Env, userHome: string, branch: string): string | null {
  const taskId = taskOfBranch(branch);
  const team = env[ENV.team]?.trim() ?? '';
  if (taskId === null || team === '') return null;
  return join(taskFolder(resolveKitHome(env, userHome), team, taskId), PULL_TEXT_FILE);
}

const ASK =
  'write the pull request text (What, Why and a Reach line: all users, teamrig development or one team, CONTRIBUTING.md, Where a change lives)';

/**
 * The pull request text: `--note-file` when given (a missing one throws, as a usage error), else the task's file when
 * it exists; refused when there is none, or when it states no Reach.
 */
export function pullTextOf(noteFile: string | null, taskFile: string | null, readText: (path: string) => string | null): PullText {
  if (noteFile !== null) {
    const text = readText(noteFile);
    if (text === null) throw new Error(`--note-file ${noteFile}: no such file`);
    return withReach(text, `--note-file ${noteFile}`);
  }
  const text = taskFile === null ? null : readText(taskFile);
  if (text === null) {
    const where = taskFile === null ? 'pass --note-file <path>, as this branch names no task of a set team' : `in ${taskFile}, or pass --note-file <path>`;
    return { kind: 'refused', reason: `the pull request this merge opens has no text: ${ASK} ${where}` };
  }
  return withReach(text, taskFile ?? '');
}

function withReach(text: string, source: string): PullText {
  return reachOf(text) === null
    ? { kind: 'refused', reason: `${source} states no Reach: add a \`Reach:\` line or fill its \`## Reach\` section (all users, teamrig development or one team, CONTRIBUTING.md, Where a change lives)` }
    : { kind: 'found', text };
}
