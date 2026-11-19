import { isRecord } from "../core/guards.js";
/**
 * Reading GitHub's issue types (T3349). Only a repository an organisation owns has types; on one a person owns,
 * `issueTypes` is null, so an issue there opens with none.
 */
/**
 * The names of the turned-on issue types in what gh prints for the issue types query (queries.ts
 * ISSUE_TYPES_QUERY); none when the repository has no types (`issueTypes` null, as on one a person owns); undefined
 * when the output is not that query's answer.
 */
export function typeNamesIn(stdout) {
    let raw;
    try {
        raw = JSON.parse(stdout);
    }
    catch {
        return undefined;
    }
    const data = isRecord(raw) ? raw['data'] : undefined;
    const repository = isRecord(data) ? data['repository'] : undefined;
    if (!isRecord(repository)) {
        return undefined;
    }
    const types = repository['issueTypes'];
    if (types === null || types === undefined) {
        return [];
    }
    const nodes = isRecord(types) ? types['nodes'] : undefined;
    if (!Array.isArray(nodes)) {
        return undefined;
    }
    return nodes.flatMap((node) => (isRecord(node) && node['isEnabled'] === true && typeof node['name'] === 'string' ? [node['name']] : []));
}
