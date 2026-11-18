import type { KitConfig } from '../config/types.ts';
import { errorMessage } from '../core/guards.ts';
import { parkRulesOf } from '../register/park.ts';
import { openedWakeState, startedWakeState, type OpenedTab, type WakeState } from '../wake/decide.ts';
import { WakeStore } from '../wake/store.ts';
import { fileLockOf } from './file-locks.ts';
import { teamZone, type Kit } from './kit.ts';
import type { CliRuntime } from './runtime.ts';
import { teamRegister } from './team-register.ts';

/**
 * Records the tab of session `id` that teamrig opened on Claude Code session `tab`, which it resumed, as woken
 * (`openedWakeState`, src/wake/decide.ts), under the session's wake lock: the wake check keeps its state by tab, and
 * the resumed tab has the id it had before its close, so it woke again for the work its first prompt reads (T1616).
 * Written with `wake.enabled` false too, so turning wakes on finds it current. Undefined once written, else why not:
 * the tab is open by then, so the caller says so and the open stands.
 */
export function noteResumedTab(runtime: CliRuntime, kit: Kit, config: KitConfig, id: string, tab: string): Promise<string | undefined> {
  return writeTabState(runtime, kit, config, id, tab, openedWakeState);
}

/**
 * Records the tab of session `id` that started on the new Claude Code session `tab` (`startedWakeState`), at its
 * SessionStart, so work handed while its first turn runs wakes it at its first idle check instead of being taken as
 * known there (T4222). Written with `wake.enabled` false too. Undefined once written or left as it was, else why not.
 */
export function noteStartedTab(runtime: CliRuntime, kit: Kit, config: KitConfig, id: string, tab: string): Promise<string | undefined> {
  return writeTabState(runtime, kit, config, id, tab, startedWakeState);
}

async function writeTabState(
  runtime: CliRuntime,
  kit: Kit,
  config: KitConfig,
  id: string,
  tab: string,
  stateOf: (tab: OpenedTab) => WakeState | undefined,
): Promise<string | undefined> {
  const store = new WakeStore(runtime.files, kit.paths.wake);
  try {
    await fileLockOf(runtime, store.lockOf(id), config.lock).run(async (): Promise<void> => {
      const { snapshot, elsewhere } = await teamRegister(runtime, kit.paths, config).snapshotWithElsewhere();
      const previous = await store.read(id);
      const zone = teamZone(config, runtime);
      const parking = parkRulesOf(config);
      const state = stateOf({ tasks: snapshot.state.tasks, elsewhere, session: id, tab, now: runtime.clock.now(), zone, maxPriority: config.wake.priority, parking, previous });
      if (state !== undefined) await store.write(id, state);
    });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}
