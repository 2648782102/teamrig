import { formatPushed, parsePushed } from "../issues/pushed-record.js";
import { fileLockOf } from "./file-locks.js";
/**
 * The pushed record (issues/pushed-record.ts) in the team's state folder. Each change reads, moves and writes the
 * whole file under its own lock, so a push, a claim and an `issue label` run at once each keep the others' writes.
 */
export class FilePushedStore {
    files;
    lock;
    path;
    constructor(files, lock, path) {
        this.files = files;
        this.lock = lock;
        this.path = path;
    }
    async read() {
        return parsePushed((await this.files.read(this.path)) ?? '');
    }
    async update(change) {
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
export function pushedStoreOf(runtime, paths, lock) {
    return new FilePushedStore(runtime.files, fileLockOf(runtime, paths.githubPushedLock, lock), paths.githubPushed);
}
