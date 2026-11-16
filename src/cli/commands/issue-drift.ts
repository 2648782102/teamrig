import type { KitConfig } from '../../config/types.ts';
import { formatDrift, parseDrift, stepDrift, type Drift, type DriftRead } from '../../github/drift.ts';
import { fileLockOf } from '../file-locks.ts';
import type { Kit } from '../kit.ts';
import type { CliRuntime } from '../runtime.ts';

/**
 * The drift check's part of a sync that writes (T3205, github/drift.ts): the rows found in what `read` names (each
 * repository's issues, and its pull requests) replace theirs in the drift file, under the sync's lock like the clocks,
 * and a source not read keeps its rows. `check` shows them to the lead as GH-DRIFT (src/cli/github-drift-check.ts).
 */
export async function recordDrift(runtime: CliRuntime, kit: Kit, config: KitConfig, read: DriftRead, found: readonly Drift[]): Promise<void> {
  await fileLockOf(runtime, kit.paths.githubSyncLock, config.lock).run(async (): Promise<void> => {
    const before = parseDrift((await runtime.files.read(kit.paths.githubDrift)) ?? '');
    await runtime.files.write(kit.paths.githubDrift, formatDrift(stepDrift(before, read, found)));
  });
}
