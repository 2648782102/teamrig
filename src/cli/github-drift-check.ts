import type { Files } from '../core/files.ts';
import { driftKey, driftText, parseDrift } from '../github/drift.ts';
import type { UnownedWarning } from './unowned.ts';

/**
 * GH-DRIFT (T3205), for `check`: a GitHub thread whose labels disagree with what is happening on it, as the last
 * writing sync read it, so it costs no GitHub call. Keyed by thread and kind: the lead is told once while it stands.
 */
export async function githubDriftWarnings(files: Pick<Files, 'read'>, driftFile: string): Promise<UnownedWarning[]> {
  return parseDrift((await files.read(driftFile)) ?? '').map((drift) => ({ key: driftKey(drift), source: 'the drift check [github]', text: driftText(drift) }));
}
