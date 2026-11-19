import { refTarget } from "../issues/links.js";
import { issueRef } from "./map.js";
import { importedTasks, linkedRefs, planSync } from "./plan.js";
/**
 * The repositories, other than the `listed` ones, that the team's tasks hold refs under with a number of `numbers`
 * (the issues a sync would add): names a listed repository may have had before it was renamed or moved, which keep
 * their issue numbers. In lowercase, as the host matches them.
 */
export function formerNames(tasks, listed, numbers) {
    const names = new Set();
    for (const task of tasks) {
        const target = refTarget(task);
        if (target !== undefined && numbers.has(target.number) && !listed.includes(target.repo)) {
            names.add(target.repo);
        }
    }
    return [...names];
}
/**
 * `tasks` with each ref under a former name read as under the listed repository it moved to (`moved`: former name to
 * listed name), so an issue matches the task that held it before the move.
 */
export function underNewNames(tasks, moved) {
    return tasks.map((task) => {
        const target = refTarget(task);
        const now = target === undefined ? undefined : moved.get(target.repo);
        return target === undefined || now === undefined ? task : { ...task, ref: issueRef(now, target.number) };
    });
}
/**
 * Which of `formers` the host now knows as `repo`, each read once a run: `names` keeps every answer, so a former name
 * met again for another repository costs no second read. A read that fails fails the whole answer, as an issue the
 * sync cannot tell from one a task holds must not be added.
 */
export async function movedInto(host, repo, formers, names) {
    const moved = new Map();
    for (const former of formers) {
        const name = names.get(former) ?? (await host.repoName(repo, former));
        names.set(former, name);
        if (name.kind === 'failed') {
            return { kind: 'failed', reason: `reading whether ${former} is now ${repo}: ${name.reason}` };
        }
        if (name.kind === 'found' && name.name.toLowerCase() === repo) {
            moved.set(former, repo);
        }
    }
    return { kind: 'read', moved };
}
/**
 * One line per former name now `repo`: how many tasks still hold refs under it, and that `teamrig refs apply` points
 * them at the new name.
 */
export function movedLines(repo, moved, tasks) {
    return [...moved.keys()].map((former) => {
        const held = tasks.filter((task) => refTarget(task)?.repo === former).length;
        return `MOVED ${former} is now ${repo}: its issues match the ${held} task(s) holding refs under ${former}; teamrig refs apply points them at ${repo}`;
    });
}
/**
 * The sync plan of a repository. Only when it would add an issue whose number a task holds under a repository the
 * team does not list is that name read (movedInto); when it is the repository now, its tasks match the issues and the
 * plan is made again, so a renamed or moved repository adds no second task for an issue the team holds. A run that
 * would add nothing reads nothing more.
 */
export async function planRepo(host, read, rules, names) {
    const { repo, issues, tasks, listed } = read;
    const first = planSync(issues, importedTasks(tasks), rules, linkedRefs(tasks));
    const adding = new Set(first.steps.flatMap((step) => (step.kind === 'add' ? [step.ref] : [])));
    const numbers = new Set(issues.filter((issue) => adding.has(issueRef(issue.repo, issue.number))).map((issue) => issue.number));
    const formers = formerNames(tasks, listed, numbers);
    if (formers.length === 0) {
        return { kind: 'planned', tasks, plan: first, lines: [] };
    }
    const moves = await movedInto(host, repo, formers, names);
    if (moves.kind === 'failed') {
        return moves;
    }
    if (moves.moved.size === 0) {
        return { kind: 'planned', tasks, plan: first, lines: [] };
    }
    const matched = underNewNames(tasks, moves.moved);
    return { kind: 'planned', tasks: matched, plan: planSync(issues, importedTasks(matched), rules, linkedRefs(matched)), lines: movedLines(repo, moves.moved, tasks) };
}
