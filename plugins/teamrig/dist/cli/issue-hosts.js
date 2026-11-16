import { GitHubIssueHost } from "../github/host.js";
import { RepoTokens } from "../github/tokens.js";
import { RecordingIssueHost } from "../issues/recording-host.js";
import { RefusedError } from "./runtime.js";
/**
 * The adapter for a host kind (issues/host.ts), the one place the CLI names a host. A command makes one per run and
 * keeps it, so the run reads each owner's saved key once (github/tokens.ts caches it). Every host it makes moves
 * `pushed`, the team's pushed record, by each status label or assignee write it sends, so no command's write is ever
 * taken by the status push for a person's change (T3230).
 */
export function hostOf(kind, runtime, scanner, pushed) {
    return new RecordingIssueHost(hostAdapterOf(kind, runtime, scanner), pushed, () => runtime.clock.now());
}
function hostAdapterOf(kind, runtime, scanner) {
    switch (kind) {
        case 'github':
            return new GitHubIssueHost(runtime.gh, new RepoTokens(runtime.credentials, runtime.env), scanner);
    }
}
/** The repositories to read: every one of `github.repos`, or the one `--repo` names, which must be among them. */
export function reposOf(repos, asked) {
    if (asked === undefined) {
        return repos;
    }
    const repo = asked.trim().toLowerCase();
    if (!repos.includes(repo)) {
        throw new RefusedError(`--repo ${asked} is not one of github.repos (${repos.join(', ')})`);
    }
    return [repo];
}
