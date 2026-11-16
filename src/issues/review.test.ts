import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gatedPathsIn, reviewPull, type ReviewDraft, type ReviewGate } from './review.ts';
import { FAKE_HEAD, FakeReviewHost } from '../testing/fake-review-host.ts';
import type { IssueTarget } from './host.ts';

const PULL: IssueTarget = { repo: 'acme/web', number: 12 };
const APPROVE: ReviewDraft = { target: PULL, verdict: 'approve', head: FAKE_HEAD };
const OPEN_GATE: ReviewGate = { gatedPaths: [] };
const GUARDED: ReviewGate = { gatedPaths: ['src/guard/', 'tools/ship'] };

async function run(host: FakeReviewHost, draft: ReviewDraft, gate: ReviewGate): Promise<{ readonly posted: boolean; readonly lines: string[] }> {
  const lines: string[] = [];
  const posted = await reviewPull(host, draft, gate, (line) => lines.push(line));
  return { posted, lines };
}

describe('gatedPathsIn', () => {
  it('takes a path equal to a prefix or inside it, never one that only starts with its letters', () => {
    const paths = ['src/guard/a.ts', 'src/guards.ts', 'tools/ship', 'tools/ship/ship.ts', 'tools/shipping.ts', 'README.md'];
    assert.deepEqual(gatedPathsIn(paths, ['src/guard/', 'tools/ship']), ['src/guard/a.ts', 'tools/ship', 'tools/ship/ship.ts']);
  });

  it('covers nothing with no prefix, or an empty or slash-only one', () => {
    assert.deepEqual(gatedPathsIn(['a/b.ts'], []), []);
    assert.deepEqual(gatedPathsIn(['a/b.ts'], ['', '/']), []);
  });
});

describe('reviewPull', () => {
  it('posts an approval bound to the head the reviewer read, and says so', async () => {
    const host = new FakeReviewHost().holds(PULL);
    const { posted, lines } = await run(host, APPROVE, OPEN_GATE);
    assert.equal(posted, true);
    assert.deepEqual(host.reviews, [APPROVE]);
    assert.deepEqual(lines, ['ACCESS acme: writes as the test', `REVIEWED acme/web#12: approved at ${FAKE_HEAD.slice(0, 9)}`]);
    assert.deepEqual(host.pathReads, [], 'no gated path, no files read');
  });

  it('posts a change request with its text, whatever paths it changes and with no pass named', async () => {
    const host = new FakeReviewHost().holds(PULL, {}, ['src/guard/a.ts']);
    const draft: ReviewDraft = { target: PULL, verdict: 'request-changes', head: FAKE_HEAD, body: 'split the parser' };
    const { posted, lines } = await run(host, draft, GUARDED);
    assert.equal(posted, true);
    assert.deepEqual(host.reviews, [draft]);
    assert.equal(lines.at(-1), `REVIEWED acme/web#12: changes requested at ${FAKE_HEAD.slice(0, 9)}`);
    assert.deepEqual(host.pathReads, []);
  });

  it('refuses a head that moved since the read, posting nothing', async () => {
    const moved = 'd'.repeat(40);
    const host = new FakeReviewHost().holds(PULL, { head: moved });
    const { posted, lines } = await run(host, APPROVE, OPEN_GATE);
    assert.equal(posted, false);
    assert.deepEqual(host.reviews, []);
    assert.equal(lines.at(-1), `FAILED acme/web#12: its head is now ddddddddd, not the ccccccccc you read: read the new commits, then review that head; no review was posted`);
  });

  it("refuses the access's own pull request, its login in any case", async () => {
    const host = new FakeReviewHost().holds(PULL, { author: 'Octo' }).actsAs('octo');
    const { posted, lines } = await run(host, APPROVE, OPEN_GATE);
    assert.equal(posted, false);
    assert.deepEqual(host.reviews, []);
    assert.equal(lines.at(-1), "FAILED acme/web#12: it is octo's own pull request, the account the access acts as: another reviewer reviews it; no review was posted");
  });

  it('refuses a merged or closed pull request, and a number that is none', async () => {
    for (const state of ['merged', 'closed'] as const) {
      const host = new FakeReviewHost().holds(PULL, { state });
      const { posted, lines } = await run(host, APPROVE, OPEN_GATE);
      assert.equal(posted, false, state);
      assert.equal(lines.at(-1), `FAILED acme/web#12: it is ${state}: a review goes only on an open pull request; no review was posted`);
    }
    const none = await run(new FakeReviewHost(), APPROVE, OPEN_GATE);
    assert.equal(none.lines.at(-1), 'FAILED acme/web#12: acme/web#12 is no pull request the access can see; no review was posted');
  });

  it('refuses an approval of a gated change with no security pass, naming at most three paths', async () => {
    const paths = ['src/guard/a.ts', 'src/guard/b.ts', 'tools/ship/ship.ts', 'src/guard/c.ts', 'README.md'];
    const host = new FakeReviewHost().holds(PULL, {}, paths);
    const { posted, lines } = await run(host, APPROVE, GUARDED);
    assert.equal(posted, false);
    assert.deepEqual(host.reviews, []);
    assert.equal(
      lines.at(-1),
      "FAILED acme/web#12: it changes src/guard/a.ts, src/guard/b.ts, tools/ship/ship.ts and 1 more, under github.reviewGatedPaths: approve it only with --verdict naming the security reviewer's done task; no review was posted",
    );
  });

  it('approves a gated change once the security pass is named, and says which', async () => {
    const host = new FakeReviewHost().holds(PULL, {}, ['tools/ship/ship.ts']);
    const { posted, lines } = await run(host, APPROVE, { ...GUARDED, verdict: 'T9 (done by security)' });
    assert.equal(posted, true);
    assert.equal(lines.at(-1), `REVIEWED acme/web#12: approved at ${FAKE_HEAD.slice(0, 9)}, its gated paths passed by T9 (done by security)`);
  });

  it('approves with gated prefixes set when the change touches none of them, with no pass named', async () => {
    const host = new FakeReviewHost().holds(PULL, {}, ['docs/a.md']);
    const { posted } = await run(host, APPROVE, GUARDED);
    assert.equal(posted, true);
    assert.deepEqual(host.pathReads, ['acme/web#12']);
  });

  it('posts nothing when the host, the pull request, the account or the paths cannot be read, giving the reason', async () => {
    const cases: Array<[FakeReviewHost, string]> = [
      [new FakeReviewHost().holds(PULL).unreachable('no token saved for acme'), 'no token saved for acme'],
      [new FakeReviewHost().holds(PULL).failsPull('gh api exited 1'), 'gh api exited 1'],
      [new FakeReviewHost().holds(PULL).failsViewer('the account read failed'), 'the account read failed'],
      [new FakeReviewHost().holds(PULL, {}, ['src/guard/a.ts']).failsPaths('a files page failed'), 'a files page failed'],
    ];
    for (const [host, reason] of cases) {
      const { posted, lines } = await run(host, APPROVE, GUARDED);
      assert.equal(posted, false, reason);
      assert.deepEqual(host.reviews, [], reason);
      assert.equal(lines.at(-1), `FAILED acme/web#12: ${reason}; no review was posted`);
    }
  });

  it("says a failed post's reason", async () => {
    const host = new FakeReviewHost().holds(PULL).failsReview('Unprocessable Entity');
    const { posted, lines } = await run(host, APPROVE, OPEN_GATE);
    assert.equal(posted, false);
    assert.equal(lines.at(-1), 'FAILED acme/web#12: Unprocessable Entity; no review was posted');
  });
});
