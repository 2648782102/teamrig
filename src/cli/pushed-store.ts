import type { LockConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import type { FileLock } from '../core/lock.ts';
import { formatPushed, parsePushed, type PushedState } from '../issues/pushed-record.ts';
import type { PushedStore } from '../issues/recording-host.ts';
import { fileLockOf } from './file-locks.ts';
import type { CliRuntime } from './runtime.ts';

/**
 * The pushed record (issues/pushed-record.ts) in the team's state folder. Each change reads, moves and writes the
 * whole file under its own lock, so a push, a claim and an `issue label` run at once each keep the others' writes.
 */
export class FilePushedStore implements PushedStore {
  private readonly files: Files;
  private readonly lock: FileLock;
  private readonly path: string;

  constructor(files: Files, lock: FileLock, path: string) {
    this.files = files;
    this.lock = lock;
    this.path = path;
  }

  async read(): Promise<PushedState> {
    return parsePushed((await this.files.read(this.path)) ?? '');
  }

  async update(change: (state: PushedState) => PushedState): Promise<void> {
    await this.lock.run(async () => {
      const before = await this.read();
      const after = change(before);
      if (after !== before) {
        await this.files.write(this.path, formatPushed(after));
      }
    });
  }
}

/** The team's pushed record, in its state folder. */
export function pushedStoreOf(runtime: CliRuntime, paths: TeamPaths, lock: LockConfig): FilePushedStore {
  return new FilePushedStore(runtime.files, fileLockOf(runtime, paths.githubPushedLock, lock), paths.githubPushed);
}
