import { join } from 'node:path';
import { parseConfigText } from '../../src/config/text.ts';
import { ENV, type Env, resolveKitHome, taskFolder, teamHome } from '../../src/core/home.ts';
import { privateShapeIn } from '../../src/core/private-shapes.ts';
import { SecretScanner } from '../../src/core/secrets.ts';
import { taskOfBranch } from './approval.ts';

/**
 * The text of the pull request a merge opens (T3420): What, Why and Reach, as `.github/pull_request_template.md`
 * asks, so a ship-made pull request says what a hand-opened one does. It comes from `--note-file`, else from the
 * `pr.md` in the folder of the branch's task (`teamrig files T<id>`), where a session writes it before asking for
 * approval. A merge with no such text, one whose Reach is empty, or one holding a secret's shape or private data, is
 * refused before any GitHub call: the task folder is private and holds logs and notes, while the pull request is public.
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
 * The secret scan for the team the merge runs for (`TEAMRIG_TEAM`): the built-in shapes plus its
 * `register.secretPatterns`, as `teamrig issue` scans an issue; the built-in shapes alone when no team is set or its
 * config cannot be read, so a text is never published unscanned.
 */
export function teamSecretScanner(env: Env, userHome: string, readText: (path: string) => string | null): SecretScanner {
  const team = env[ENV.team]?.trim() ?? '';
  const text = team === '' ? null : readText(join(teamHome(resolveKitHome(env, userHome), team), 'config.json'));
  const read = text === null ? null : parseConfigText(text);
  return new SecretScanner(read?.status === 'loaded' ? read.config.register.secretPatterns : []);
}

/**
 * The pull request text: `--note-file` when given (a missing one throws, as a usage error), else the task's file when
 * it exists; refused when there is none, when it holds a secret's shape or private data, or when it states no Reach.
 */
export function pullTextOf(noteFile: string | null, taskFile: string | null, readText: (path: string) => string | null, scanner: SecretScanner): PullText {
  if (noteFile !== null) {
    const text = readText(noteFile);
    if (text === null) throw new Error(`--note-file ${noteFile}: no such file`);
    return publishable(text, `--note-file ${noteFile}`, scanner);
  }
  const text = taskFile === null ? null : readText(taskFile);
  if (text === null) {
    const where = taskFile === null ? 'pass --note-file <path>, as this branch names no task of a set team' : `in ${taskFile}, or pass --note-file <path>`;
    return { kind: 'refused', reason: `the pull request this merge opens has no text: ${ASK} ${where}` };
  }
  return publishable(text, taskFile ?? '', scanner);
}

/** The text when a public pull request may carry it: no secret's shape, no private data, and a Reach. Names the shape, never the match. */
function publishable(text: string, source: string, scanner: SecretScanner): PullText {
  const secret = scanner.refusal(source, text);
  if (secret !== undefined) return { kind: 'refused', reason: `${secret}, as the pull request is public` };
  const shape = privateShapeIn(text);
  if (shape !== undefined) return { kind: 'refused', reason: `${source} holds private data (${shape.description}): take it out, as the pull request is public` };
  return reachOf(text) === null
    ? { kind: 'refused', reason: `${source} states no Reach: add a \`Reach:\` line or fill its \`## Reach\` section (all users, teamrig development or one team, CONTRIBUTING.md, Where a change lives)` }
    : { kind: 'found', text };
}
