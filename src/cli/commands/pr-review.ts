import type { SessionAddress } from '../../core/address.ts';
import { roleHolderOf } from '../../config/roster.ts';
import { COMMIT_ID } from '../../github/gh.ts';
import { reviewPull, type ReviewDraft, type ReviewVerdict } from '../../issues/review.ts';
import { GENERIC_REVIEW_PATHS } from '../../push-guard/review-paths.ts';
import type { Task } from '../../register/fold.ts';
import { requiredFlag, type ParsedArgs } from '../args.ts';
import { pullReviewHostOf } from '../issue-hosts.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';
import { bodyFileOf, checkedRepo, scannerAfter, targetOf } from './issue.ts';
import { openTeam } from './register-team.ts';

/** A task id as `--verdict` takes it. */
const TASK_ID = /^T[1-9][0-9]*$/u;

/**
 * `pr review <owner/name#n> --approve|--request-changes --head <sha> [--body-file <path>] [--verdict T<id>]` (T3227):
 * posts one review on a pull request of the team's repositories, bound to the head commit the reviewer read, through
 * the same caller, repository and text checks as `issue comment` (issues/review.ts holds what it checks on GitHub
 * before the post). A change request says what to change, so it needs a body. An approval of a change to a security
 * path of the merge review gate names the security reviewer's done task with `--verdict`. The review is a
 * reviewer's word on GitHub: it approves no task's wait and merges nothing. Exit 1 when the host failed, else 0.
 */
export async function prReview(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  const target = targetOf(args);
  const verdict = verdictOf(args);
  const head = headOf(requiredFlag(args.flags, 'head'));
  const pass = args.flags.get('verdict');
  if (pass !== undefined && verdict !== 'approve') {
    throw new RefusedError('--verdict names the security pass an approval needs: a change request takes none');
  }
  const checked = await checkedRepo(args, runtime, target.repo);
  const bodyFile = args.flags.get('body-file');
  const body = bodyFile === undefined ? undefined : await bodyFileOf(bodyFile, runtime, checked.config);
  if (verdict === 'request-changes' && body === undefined) {
    throw new RefusedError('--request-changes needs --body-file: a change request says what to change');
  }
  const passed = pass === undefined ? undefined : await securityPassFor(runtime, pass);
  const scanner = scannerAfter(checked, runtime, body === undefined ? undefined : { flag: '--body-file', text: body });
  if (scanner === undefined) {
    return EXIT.ok;
  }
  const draft: ReviewDraft = { target, verdict, head, ...(body === undefined ? {} : { body }) };
  const gate = { entries: [...GENERIC_REVIEW_PATHS, ...checked.config.pushGuard.reviewPaths], ...(passed === undefined ? {} : { verdict: passed }) };
  const posted = await reviewPull(pullReviewHostOf(checked.kind, runtime, scanner), draft, gate, (line) => runtime.out.stdout(line));
  return posted ? EXIT.ok : EXIT.failed;
}

/** The one verdict the switches give; refused with neither or both. */
function verdictOf(args: ParsedArgs): ReviewVerdict {
  const approve = args.switches.has('approve');
  const changes = args.switches.has('request-changes');
  if (approve === changes) {
    throw new RefusedError('pr review takes one of --approve and --request-changes');
  }
  return approve ? 'approve' : 'request-changes';
}

/** The full head commit id `--head` gives, in lowercase; refused when it is short or no commit id. */
function headOf(text: string): string {
  const head = text.trim().toLowerCase();
  if (!COMMIT_ID.test(head)) {
    throw new RefusedError(`--head takes the full 40-character id of the head commit you read (git rev-parse), not ${JSON.stringify(text)}`);
  }
  return head;
}

/** The security pass `--verdict` names, read from the caller's register and the team tree's others. */
async function securityPassFor(runtime: CliRuntime, id: string): Promise<string> {
  const team = await openTeam(runtime, 'read');
  const [snapshot, elsewhere] = await Promise.all([team.register.snapshot(), team.register.elsewhere()]);
  const own = snapshot.state.tasks.get(id);
  const found = own === undefined ? elsewhere.get(id) : { team: team.paths.team, task: own };
  return securityPassOf(id, found, roleHolderOf(team.config.roles, 'securityReviewer', team.paths.team), team.paths.team);
}

/**
 * The line naming the security pass of `id` (`T9 (done by security)`), once it is a done task the team's security
 * reviewer (roles.securityReviewer) owns; refused otherwise, as an approval of a gated change rests on that pass.
 */
export function securityPassOf(id: string, found: { readonly team: string; readonly task: Task } | undefined, reviewer: SessionAddress | undefined, ownTeam: string): string {
  if (!TASK_ID.test(id)) {
    throw new RefusedError(`--verdict takes the security reviewer's done task, such as T12, not ${JSON.stringify(id)}`);
  }
  if (reviewer === undefined) {
    throw new RefusedError('the team names no security reviewer (roles.securityReviewer): no task can pass a gated change');
  }
  const shown = reviewer.team === ownTeam ? reviewer.id : `${reviewer.team}/${reviewer.id}`;
  if (found === undefined) {
    throw new RefusedError(`--verdict ${id} is no task of the team tree: name the security reviewer's done task`);
  }
  if (found.team !== reviewer.team || found.task.owner !== reviewer.id) {
    throw new RefusedError(`--verdict ${id} is not a task of ${shown}, the security reviewer: name its done task`);
  }
  if (found.task.status !== 'done') {
    throw new RefusedError(`--verdict ${id} is ${found.task.status}, not done: approve once ${shown} has passed the change`);
  }
  return `${id} (done by ${shown})`;
}
