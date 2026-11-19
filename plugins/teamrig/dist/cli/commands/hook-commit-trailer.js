import { recordField, stringField } from "../../core/guards.js";
import { claudeConfigDir, ENV } from "../../core/home.js";
import { gitTakesTrailer, trailerInput, withCommitTrailer } from "../../hooks/commit-trailer.js";
import { anyBashRuleMatches, readBashAskDeny, ruleSettingsFiles } from "../../permissions/bash-rules.js";
import { envSession } from "./hook-input.js";
import { callCwdOf } from "./hook-route-context.js";
/**
 * Whether a Bash `ask` or `deny` rule of the session's settings could match `command` as sent, or a settings file could
 * not be read: the rewrite would put the trailer between the words such a rule names (`Bash(git commit --no-verify:*)`),
 * so the rule would stop matching and the call run unasked, or unrefused, on an allow. Read only for a commit line.
 */
async function askOrDenyHolds(runtime, payload, command) {
    const started = runtime.env[ENV.claudeProjectDir]?.trim();
    const projects = [...(started === undefined || started === '' ? [] : [started]), callCwdOf(runtime, payload)];
    const read = await readBashAskDeny(runtime.files, ruleSettingsFiles(claudeConfigDir(runtime.env, runtime.userHome), projects, runtime.platform));
    return read.kind === 'unreadable' || anyBashRuleMatches(read.rules, command);
}
/**
 * The tool input a team session's Bash `git commit` runs instead, carrying the Made-with trailer (T3270,
 * hooks/commit-trailer.ts); undefined, so the call runs as sent, for a tab with no `$TEAMRIG_SESSION` (a person's own
 * Claude Code), a team with `github.stamp: false`, another tool, a line that is no leading git commit, amends one or is
 * stamped already, a line a Bash ask or deny rule could match, and a git older than 2.32; the rules and git are asked
 * only once the line is a commit.
 */
export async function commitTrailerInputOf(runtime, config, payload) {
    const input = recordField(payload, 'tool_input');
    const command = input === undefined ? undefined : stringField(input, 'command');
    if (input === undefined || command === undefined || !config.github.stamp || envSession(runtime) === undefined || stringField(payload, 'tool_name') !== 'Bash') {
        return undefined;
    }
    const rewritten = withCommitTrailer(command);
    if (rewritten === undefined || (await askOrDenyHolds(runtime, payload, command))) {
        return undefined;
    }
    return gitTakesTrailer(runtime.mergeGit.gitVersion(callCwdOf(runtime, payload))) ? trailerInput(input, rewritten) : undefined;
}
