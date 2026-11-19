import { recordField } from "../core/guards.js";
import { claudeSettingsFiles, jsonObjectOf } from "../doctor/settings-env.js";
/**
 * The Bash `ask` and `deny` rules of the Claude Code settings a session reads, and a loose match of one against a
 * line (T3270). A hook that rewrites a Bash line reads them first and leaves the line as sent when any rule could
 * match it, so a person's own prompt or refusal never stops matching because teamrig changed the line. The match is
 * looser than Claude Code's own on purpose: matching too much only leaves a line unrewritten.
 */
/** Claude Code's managed settings file on each platform; an admin's rules there apply to every session. */
export function managedSettingsFile(platform) {
    if (platform === 'win32') {
        return String.raw `C:\Program Files\ClaudeCode\managed-settings.json`;
    }
    return platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
}
/**
 * The settings files a session's rules come from: the managed file, the user's, then the shared and local files of
 * each project folder given (the folder the session started in and the call's own), each path once.
 */
export function ruleSettingsFiles(claudeDir, projects, platform) {
    return [...new Set([managedSettingsFile(platform), ...projects.flatMap((project) => claudeSettingsFiles(claudeDir, project))])];
}
/** The strings of one `permissions` list, empty when it has none. */
function listOf(permissions, key) {
    const list = permissions?.[key];
    return Array.isArray(list) ? list.filter((rule) => typeof rule === 'string') : [];
}
/** The `permissions.ask` and `permissions.deny` rules for the Bash tool across `paths`; a missing file adds none. It only reads. */
export async function readBashAskDeny(files, paths) {
    const rules = [];
    for (const path of paths) {
        const text = await files.read(path);
        if (text === undefined) {
            continue;
        }
        const settings = jsonObjectOf(text);
        if (settings === undefined) {
            return { kind: 'unreadable', path };
        }
        const permissions = recordField(settings, 'permissions');
        rules.push(...[...listOf(permissions, 'ask'), ...listOf(permissions, 'deny')].filter((rule) => bashPatternOf(rule) !== undefined));
    }
    return { kind: 'rules', rules };
}
/** A Bash rule's pattern: `*` for the bare tool (`Bash`, `Bash()`, `Bash(*)`), else its text; undefined for another tool's rule. */
export function bashPatternOf(rule) {
    const match = /^Bash(?:\(([\s\S]*)\))?$/u.exec(rule.trim());
    if (match === null) {
        return undefined;
    }
    const pattern = (match[1] ?? '').trim();
    return pattern === '' ? '*' : pattern;
}
/** The pattern as a whole-text regex: each `*`, and a `:*` prefix ending, stands for any text; the rest is literal. */
function patternRegex(pattern) {
    const body = pattern
        .replace(/:\*$/u, '*')
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, String.raw `\$&`))
        .join('[\\s\\S]*');
    return new RegExp(`^${body}$`, 'u');
}
/** The line, then each command in it split at `&&`, `||`, `;`, `|` and line ends, each trimmed: what a rule may be held against. */
function linePieces(line) {
    return [line.trim(), ...line.split(/&&|\|\||[;|\n]/u).map((piece) => piece.trim())].filter((piece) => piece !== '');
}
/** Whether any of `rules` (Bash rules, as `readBashAskDeny` gives them) could match `line` or one of its commands. */
export function anyBashRuleMatches(rules, line) {
    const pieces = linePieces(line);
    return rules.some((rule) => {
        const pattern = bashPatternOf(rule);
        if (pattern === undefined) {
            return false;
        }
        const regex = patternRegex(pattern);
        return pieces.some((piece) => regex.test(piece));
    });
}
