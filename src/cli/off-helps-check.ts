import type { KitConfig } from '../config/types.ts';
import { KIT_NAME } from '../core/home.ts';
import { parseIssueTarget } from '../issues/host.ts';
import type { Task } from '../register/fold.ts';
import { ISSUE_REF_PREFIX } from '../register/model.ts';
import { isActive } from '../register/stats.ts';
import type { UnownedWarning } from './unowned.ts';

/**
 * OFF-HELPS (T4584, #1864), for `check`: a feature that is off by default and would help the team now, with the
 * reason read from the team's own data and the command that turns it on. A feature no one is told of stays unused
 * (the status push, built 11-15, went unused for days by the team that asked for it). Turning a feature on is the
 * lead's call or the owner's, so each line goes to the lead as an unowned warning, keyed by its config key: the lead
 * is told of it once, and `featureHints.dismiss` silences it for good. Each probe reads only what teamrig already
 * holds (the resolved config, the register): none calls the network or writes anything.
 */

/**
 * The fewest active tasks holding issues of one repository that make linking issues a habit rather than a one-off:
 * below it, the import or the push would serve too little to ask the lead about.
 */
export const OFF_HELPS_MIN_ISSUE_TASKS = 3;

/** What a probe reads: the team's resolved config, so an inherited "on" prints nothing, and its tasks. */
export interface HintContext {
  readonly config: KitConfig;
  readonly tasks: readonly Task[];
}

/** One feature that is off by default, and when it would help. */
export interface FeatureHint {
  /** Its config key, as `teamrig config set` takes it. */
  readonly key: string;
  readonly isOff: (config: KitConfig) => boolean;
  /** Why it would help the team now, or undefined while it would not. */
  readonly wouldHelp: (context: HintContext) => string | undefined;
  /** The command that turns it on. */
  readonly turnOn: (context: HintContext) => string;
}

/** The active tasks holding an issue, by its repository in lowercase, the repository holding most first. */
function issueTasksByRepo(tasks: readonly Task[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const target = isActive(task.status) && task.ref?.startsWith(ISSUE_REF_PREFIX) === true ? parseIssueTarget(task.ref.slice(ISSUE_REF_PREFIX.length)) : undefined;
    if (target !== undefined) {
      const repo = target.repo.toLowerCase();
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

/** The repository most active tasks hold issues of, when it reaches OFF_HELPS_MIN_ISSUE_TASKS. */
function busiestRepo(tasks: readonly Task[]): [string, number] | undefined {
  const [first] = issueTasksByRepo(tasks);
  return first !== undefined && first[1] >= OFF_HELPS_MIN_ISSUE_TASKS ? first : undefined;
}

/** How many active tasks hold issues of the repositories listed in `github.repos`. */
function listedIssueTasks({ config, tasks }: HintContext): number {
  const listed = new Set(config.github.repos);
  return issueTasksByRepo(tasks).reduce((sum, [repo, count]) => sum + (listed.has(repo) ? count : 0), 0);
}

/**
 * The hint table, in the order `check` prints it. Slice 1 holds the GitHub rows; the other off-by-default features
 * join it with their probes (plan in #1864).
 */
export const FEATURE_HINTS: readonly FeatureHint[] = [
  {
    key: 'github.repos',
    isOff: (config) => config.github.repos.length === 0,
    wouldHelp: ({ tasks }) => {
      const busiest = busiestRepo(tasks);
      return busiest === undefined
        ? undefined
        : `${busiest[1]} active tasks hold issues of ${busiest[0]}, linked by hand: the import makes each new issue there a task and tells its owner the issue's news`;
    },
    turnOn: ({ tasks }) => `${KIT_NAME} config set github.repos ${busiestRepo(tasks)?.[0] ?? '<owner/name>'}`,
  },
  {
    key: 'github.statusPush',
    isOff: (config) => config.github.repos.length > 0 && !config.github.statusPush,
    wouldHelp: (context) => {
      const count = listedIssueTasks(context);
      return count < OFF_HELPS_MIN_ISSUE_TASKS
        ? undefined
        : `${count} active tasks hold issues of github.repos, and those issues show no task status until a session pushes it: ` +
            `the status push sends each one's labels and assignees with the automatic sync. It needs a gh login that can write issues; ` +
            `read its plan first (${KIT_NAME} issue sync --push)`;
    },
    turnOn: () => `${KIT_NAME} config set github.statusPush true`,
  },
];

/** The OFF-HELPS warnings of the features in `hints` that are off, not dismissed and would help now. */
export function offHelpsWarnings(context: HintContext, hints: readonly FeatureHint[] = FEATURE_HINTS): UnownedWarning[] {
  const dismissed = new Set(context.config.featureHints.dismiss);
  return hints.flatMap((hint) => {
    const reason = !dismissed.has(hint.key) && hint.isOff(context.config) ? hint.wouldHelp(context) : undefined;
    return reason === undefined
      ? []
      : [
          {
            key: `off-helps ${hint.key}`,
            source: 'the feature hint check [featureHints.dismiss]',
            text: `OFF-HELPS ${hint.key} is off: ${reason}. Turn on: ${hint.turnOn(context)}; or add ${hint.key} to featureHints.dismiss to stop this line`,
          },
        ];
  });
}
