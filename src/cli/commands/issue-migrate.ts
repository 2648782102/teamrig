import { resolve } from 'node:path';
import { ENV, KIT_NAME } from '../../core/home.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { issueRef } from '../../github/map.ts';
import type { GithubConfig, RolesConfig } from '../../config/types.ts';
import { issueRepoOf } from '../../github/issue-at-add.ts';
import { countsLine, parseMigrateRows, planMigration, previewMarkdown, replacedRefNote, taskIssueRow, type MigrateCreate, type MigratePlan, type MigrateRow, type RefJudge } from '../../github/migrate.ts';
import { offGitHubReason } from '../../github/off-github.ts';
import { fitIssueFields, issueRulesOf, RepoTypes } from '../../issues/issue-fields.ts';
import { RegisterPolicy } from '../../register/policy.ts';
import type { Task } from '../../register/fold.ts';
import { noPositionals, onePositional, UsageError, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { hostOf } from '../issue-hosts.ts';
import { sessionIdOf } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { GITHUB_OFF, githubOff } from './issue-sync-auto.ts';
import { reportRotation } from './register.ts';
import { openTeam, type Team } from './register-team.ts';

/** The ids of live tasks with no row a run names on its NO ROW line; the rest are counted. */
export const SHOWN_UNROWED = 20;

/**
 * `issue migrate <file> [--out <preview.md>] [--yes]` (T2550): moves the caller's team's tasks to GitHub issues from a
 * file of JSON-lines rows (github/migrate.ts), each a task's public wording or the reason it stays local;
 * `issue migrate --task <id> --issue <title> --issue-body <text> [--issue-repo <owner/name>]` (T3349) opens one task's
 * issue with no file, its kind of work and priority the task's own, in the repository `add --issue` would pick. Without
 * `--yes` it writes nothing but the `--out` preview, a page with every issue in full for a reviewer. `--yes` opens
 * each planned issue through the issue host port (issues/host.ts; on GitHub with the token saved for the repository's
 * owner, never the gh login; no saved token, or one the store could not read, stops the run), then points
 * the task's ref at it as `update <id> --ref` by the caller would, so the sync adds no second
 * task for it; a ref that is no issue gives way, named in the update's note. It stops at the first failure, and a rerun skips each task already holding its issue. Exit 1 when
 * gh failed, 2 when the register refused a ref, else 0.
 */
export async function issueMigrate(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const one = args.flags.get('task');
  const write = args.switches.has('yes');
  const caller = callerOf(args.flags, runtime.env);
  const team = await openTeam(runtime, write ? 'write' : 'read');
  const by = sessionIdOf(team.roster, caller);
  const policy = new RegisterPolicy(team.config, team.above);
  const notOnTeam = policy.checkCaller(by);
  if (notOnTeam !== undefined) {
    throw new RefusedError(notOnTeam);
  }
  const say = (line: string): void => runtime.out.stdout(line);
  if (write && githubOff(runtime.env)) {
    say(`OFF ${ENV.github}=${GITHUB_OFF} turns GitHub off on this machine; no issue was opened`);
    return EXIT.ok;
  }
  const scanner = new SecretScanner(team.config.register.secretPatterns);
  const { snapshot, elsewhere } = await team.register.snapshotWithElsewhere();
  const rows = one === undefined ? await rowsAt(runtime, resolve(runtime.cwd, fileOf(args)), scanner) : [taskRow(args, snapshot.state.tasks.get(one), one, team.config, scanner)];
  const judge: RefJudge = (task, ref) => {
    const verdict = policy.update(task, by, { ref }, refNote(task.ref), snapshot.state, elsewhere);
    return verdict.ok ? undefined : verdict.error;
  };
  const planned = planMigration(rows, snapshot.state.tasks, team.config.github.repos, judge, issueRulesOf(team.config.github), team.config.roles.securityReviewer);
  // One task's run says nothing of the tasks it was never asked about.
  const plan = one === undefined ? planned : { ...planned, unrowed: [] };
  const out = args.flags.get('out');
  if (out !== undefined) {
    const at = resolve(runtime.cwd, out);
    await runtime.files.write(at, previewMarkdown(plan));
    say(`PREVIEW FILE ${at}`);
  }
  planLines(plan).forEach(say);
  if (!write) {
    say(one === undefined ? `PREVIEW nothing was written; ${KIT_NAME} issue migrate <file> --yes opens the issues and sets each task's ref` : `PREVIEW nothing was written; the same command with --yes opens the issue and sets ${one}'s ref`);
    return EXIT.ok;
  }
  return openIssues(runtime, team, by, plan.creates, scanner);
}

/** The row file a run without `--task` names; the issue flags belong to `--task`, a file's rows holding their own. */
function fileOf(args: ParsedArgs): string {
  if (ISSUE_FLAGS.some((flag) => args.flags.has(flag))) {
    throw new UsageError('--issue, --issue-body and --issue-repo go with --task <id>: a row file holds each issue\'s own');
  }
  return onePositional(args, 'file');
}

/** The flags that give one task's issue. */
const ISSUE_FLAGS = ['issue', 'issue-body', 'issue-repo'] as const;

/**
 * The one row of `--task <id>`: the task's issue, in the repository `add --issue` would open it in; refused when there
 * is no such task, the task must stay off GitHub (off-github.ts), or the wording is not public.
 */
function taskRow(args: ParsedArgs, task: Task | undefined, id: string, config: TaskRowConfig, scanner: SecretScanner): MigrateRow {
  noPositionals(args);
  const title = args.flags.get('issue');
  const body = args.flags.get('issue-body');
  if (title === undefined || body === undefined) {
    throw new UsageError('--task takes --issue <title> and --issue-body <text>: the issue\'s public wording');
  }
  if (task === undefined) {
    throw new RefusedError(`no task ${id} in the working set`);
  }
  const off = offGitHubReason(task, config.roles.securityReviewer);
  if (off !== undefined) {
    throw new RefusedError(`${id} gets no public issue: ${off}`);
  }
  const repo = issueRepoOf(args.flags.get('issue-repo'), config.github);
  if (!repo.ok) {
    throw new RefusedError(repo.error);
  }
  const row = taskIssueRow(task, repo.value, title, body, scanner);
  if (!row.ok) {
    throw new RefusedError(row.error);
  }
  return row.value;
}

/** The team settings one task's row reads: its repositories, and the security reviewer, whose tasks stay off GitHub. */
interface TaskRowConfig {
  readonly github: Pick<GithubConfig, 'repos' | 'issueAtAdd'>;
  readonly roles: Pick<RolesConfig, 'securityReviewer'>;
}

/** The rows of the file at `path`; refused when it is missing or a row is bad. */
async function rowsAt(runtime: CliRuntime, path: string, scanner: SecretScanner): Promise<readonly MigrateRow[]> {
  const text = await runtime.files.read(path);
  if (text === undefined) {
    throw new RefusedError(`no row file ${path}`);
  }
  const parsed = parseMigrateRows(text, scanner);
  if (!parsed.ok) {
    throw new RefusedError(`${path}: ${parsed.error}`);
  }
  return parsed.value;
}

/** The note of a ref update: the ref it replaces, when there is one. */
function refNote(old: string | null): string | undefined {
  return old === null ? undefined : replacedRefNote(old);
}

/** Each ref an issue replaces, each skipped row with why, the live tasks no row names, and the counts. */
function planLines(plan: MigratePlan): string[] {
  const more = plan.unrowed.length - SHOWN_UNROWED;
  const unrowed = plan.unrowed.slice(0, SHOWN_UNROWED).join(' ');
  return [
    ...plan.creates.flatMap((create) => (create.replaces === null ? [] : [`REPLACES ${create.id}: its ref ${create.replaces} gives way to its issue`])),
    ...plan.skipped.map((skip) => `SKIPPED ${skip.id}: ${skip.reason}`),
    ...(plan.unrowed.length === 0 ? [] : [`NO ROW ${plan.unrowed.length} live task(s) no row names: ${unrowed}${more > 0 ? ` and ${more} more` : ''}`]),
    countsLine(plan),
  ];
}

/** Opens each issue and sets its task's ref, in order, stopping at the first failure. */
async function openIssues(runtime: CliRuntime, team: Team, by: string, creates: readonly MigrateCreate[], scanner: SecretScanner): Promise<ExitCode> {
  const say = (line: string): void => runtime.out.stdout(line);
  // planMigration plans issues only for github.repos, GitHub's list, so every one is GitHub's.
  const host = hostOf('github', runtime, scanner, team.config.github.stamp);
  const told = new Set<string>();
  const types = new RepoTypes(host);
  let opened = 0;
  const stopped = (id: string): string => `STOPPED at ${id} after opening ${opened} issue(s); fix the cause and rerun: tasks holding their issue are skipped`;
  for (const create of creates) {
    const reach = await host.reach(create.draft.repo, 'open');
    if (reach.kind === 'unreachable') {
      say(`FAILED ${create.id}: ${reach.reason}`);
      say(stopped(create.id));
      return EXIT.failed;
    }
    if (!told.has(reach.scope)) {
      told.add(reach.scope);
      say(`ACCESS ${reach.access}`);
    }
    const fitted = await fitIssueFields(host, create.draft, create.wanted, types);
    fitted.skipped.forEach(say);
    const end = await host.open(fitted.draft);
    if (end.kind === 'failed') {
      say(`FAILED ${create.id}: ${end.reason}`);
      say(stopped(create.id));
      return EXIT.failed;
    }
    const ref = issueRef(end.target.repo, end.target.number);
    const verdict = await team.register.update(by, create.id, { ref }, refNote(create.replaces));
    if (!verdict.ok) {
      say(`REFUSED ${create.id}: ${verdict.error}; its issue ${ref} was opened: set it with ${KIT_NAME} update ${create.id} --ref ${ref}`);
      say(stopped(create.id));
      return EXIT.refused;
    }
    reportRotation(runtime, verdict.value.rotation, team.paths);
    opened += 1;
    say(`OPENED ${create.id} ${ref}`);
  }
  say(`DONE opened ${opened} issue(s) and set each task's ref`);
  return EXIT.ok;
}
