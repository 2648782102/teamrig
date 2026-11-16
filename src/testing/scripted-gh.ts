import type { GhRequest, GhResult, GhRunner } from '../github/gh.ts';

/** What gh prints for a REST path GitHub has nothing at. */
export const GH_NOT_FOUND: GhResult = { end: { kind: 'exited', code: 1 }, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' };

/** A gh run that ended well, printing `body` as JSON. */
export function ghJson(body: unknown): GhResult {
  return { end: { kind: 'exited', code: 0 }, stdout: JSON.stringify(body), stderr: '' };
}

/**
 * A gh that reaches no network and answers each command line by the result a test scripted for it, word for word;
 * any other line answers Not Found. Every request is recorded, so a test can hold each run to the line it expects.
 */
export class ScriptedGh implements GhRunner {
  readonly ran: GhRequest[] = [];
  private readonly scripted = new Map<string, GhResult>();

  /** From now on, `args` answers `result`. */
  answers(args: readonly string[], result: GhResult): this {
    this.scripted.set(keyOf(args), result);
    return this;
  }

  run(request: GhRequest): Promise<GhResult> {
    this.ran.push(request);
    return Promise.resolve(this.scripted.get(keyOf(request.args)) ?? GH_NOT_FOUND);
  }
}

function keyOf(args: readonly string[]): string {
  return JSON.stringify(args);
}
