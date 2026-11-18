import type { KitConfig } from '../../config/types.ts';
import { recordField, stringField, type JsonRecord } from '../../core/guards.ts';
import { gitTakesTrailer, trailerInput, withCommitTrailer } from '../../hooks/commit-trailer.ts';
import type { CliRuntime } from '../runtime.ts';
import { envSession } from './hook-input.ts';
import { callCwdOf } from './hook-route-context.ts';

/**
 * The tool input a team session's Bash `git commit` runs instead, carrying the Made-with trailer (T3270,
 * hooks/commit-trailer.ts); undefined, so the call runs as sent, for a tab with no `$TEAMRIG_SESSION` (a person's own
 * Claude Code), a team with `github.stamp: false`, another tool, a line that is no leading git commit or is stamped
 * already, and a git older than 2.32, asked only once the line is a commit.
 */
export function commitTrailerInputOf(runtime: CliRuntime, config: KitConfig, payload: JsonRecord): JsonRecord | undefined {
  const input = recordField(payload, 'tool_input');
  const command = input === undefined ? undefined : stringField(input, 'command');
  if (input === undefined || command === undefined || !config.github.stamp || envSession(runtime) === undefined || stringField(payload, 'tool_name') !== 'Bash') {
    return undefined;
  }
  const rewritten = withCommitTrailer(command);
  return rewritten !== undefined && gitTakesTrailer(runtime.mergeGit.gitVersion(callCwdOf(runtime, payload))) ? trailerInput(input, rewritten) : undefined;
}
