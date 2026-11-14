import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inMinutes, minutesIn, partHeldNote, POSTPONE_IN_MAX_MINUTES, restOf } from './postpone.ts';
import type { ScheduledMeeting } from './schedule.ts';

const MEETING: ScheduledMeeting = {
  id: 'M1',
  at: Date.parse('2030-01-08T14:00:00Z'),
  minutes: 30,
  session: 'alpha',
  with: [],
  tasks: ['T3', 'T1', 'T2'],
  about: 'the release plan',
  brief: null,
  status: 'started',
  notifiedAt: null,
  by: 'lead',
  changedAt: Date.parse('2030-01-08T14:00:00Z'),
  note: null,
};

describe('meeting postpone (T2775)', () => {
  it('reads a delay in minutes or hours, from a minute to a day', () => {
    assert.equal(minutesIn('45m'), 45);
    assert.equal(minutesIn(' 2h '), 120);
    assert.equal(minutesIn('24h'), POSTPONE_IN_MAX_MINUTES);
    for (const text of ['0m', '25h', '1441m', '1.5h', 'soon', '2 hours', '-1h', '']) {
      assert.equal(minutesIn(text), undefined, text);
    }
    assert.equal(inMinutes(Date.parse('2030-01-08T10:00:00Z'), 90), Date.parse('2030-01-08T11:30:00Z'));
  });

  it('keeps the tasks with no answer, in their order, and counts the rest decided', () => {
    assert.deepEqual(restOf(MEETING, new Set(['T1', 'T9'])), { tasks: ['T3', 'T2'], decided: 1 });
    assert.deepEqual(restOf(MEETING, new Set()), { tasks: ['T3', 'T1', 'T2'], decided: 0 });
  });

  it('notes the part held, and the reason after it', () => {
    const rest = { tasks: ['T2'], decided: 2 };
    assert.equal(partHeldNote('Tue 01-08 14:00 UTC', rest, null), 'part held Tue 01-08 14:00 UTC: 2 of 3 decided');
    assert.equal(partHeldNote('Tue 01-08 14:00 UTC', rest, 'the owner was called away'), 'part held Tue 01-08 14:00 UTC: 2 of 3 decided; the owner was called away');
  });
});
