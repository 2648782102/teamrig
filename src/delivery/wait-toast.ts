import type { WaitToastConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { isRecord } from '../core/guards.ts';
import type { Mutex } from '../core/lock.ts';

const MINUTE_MS = 60_000;

/**
 * The wait toast (T4594): an OS notice that a queued step still waits for the host, so a person away from the terminal
 * sees a long line. Many steps wait at once on a busy host, each polling on its own; a notice per step would flood the
 * screen, so the host shows one per `everyMinutes`, kept in a last-toast file beside the host lock.
 */

/** The last-toast file of the host lock at `hostLock`, beside it like the lock's other files. */
export function waitToastPath(hostLock: string): string {
  return `${hostLock}.toast`;
}

/** The file lock that makes reading and writing the last-toast file one step across processes. */
export function waitToastLockPath(hostLock: string): string {
  return `${waitToastPath(hostLock)}.lock`;
}

/** What the last-toast file holds: when the host last showed a wait toast, in ms since the epoch. */
export interface LastWaitToast {
  readonly at: number;
}

function isLastWaitToast(value: unknown): value is LastWaitToast {
  return isRecord(value) && typeof value['at'] === 'number' && Number.isFinite(value['at']);
}

/**
 * Whether a step that has waited `waitedMs` shows a toast now, the host's last one shown `sinceLastMs` ago (undefined:
 * none yet). Off with `everyMinutes` 0; else due once the step has waited `afterMinutes`, and no sooner than
 * `everyMinutes` after the host's last toast, whichever step showed it. A last toast stamped in the future (a clock set
 * back) counts as none, so a wrong stamp never silences the toast.
 */
export function waitToastDue(waitedMs: number, sinceLastMs: number | undefined, config: WaitToastConfig): boolean {
  if (config.everyMinutes === 0 || waitedMs < config.afterMinutes * MINUTE_MS) {
    return false;
  }
  return sinceLastMs === undefined || sinceLastMs < 0 || sinceLastMs >= config.everyMinutes * MINUTE_MS;
}

/**
 * The host's last-toast file. A file that does not parse (a hand edit, a damaged write) reads as no toast yet: at worst
 * one toast comes early.
 */
export class WaitToastStore {
  private readonly files: Files;
  private readonly path: string;
  private readonly mutex: Mutex;

  constructor(files: Files, path: string, mutex: Mutex) {
    this.files = files;
    this.path = path;
    this.mutex = mutex;
  }

  async read(): Promise<LastWaitToast | undefined> {
    const text = await this.files.read(this.path);
    if (text === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    return isLastWaitToast(parsed) ? parsed : undefined;
  }

  /**
   * Claims the host's toast for a step waiting since `waitingSince`: true, with the time written as the last toast,
   * when one is due at `now`; false when the step has not waited long enough, the toast is off, or another step showed
   * one within `everyMinutes`. The read and the write run under the mutex, so of many steps polling at once one claims.
   */
  async claim(now: number, waitingSince: number, config: WaitToastConfig): Promise<boolean> {
    if (!waitToastDue(now - waitingSince, undefined, config)) {
      return false;
    }
    return this.mutex.run(async () => {
      const last = await this.read();
      if (!waitToastDue(now - waitingSince, last === undefined ? undefined : now - last.at, config)) {
        return false;
      }
      const toast: LastWaitToast = { at: now };
      await this.files.write(this.path, `${JSON.stringify(toast)}\n`);
      return true;
    });
  }
}
