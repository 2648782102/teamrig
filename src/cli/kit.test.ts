import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { checkedNextConfig, leadOnly, leadOrDeliveryOwnerOnly } from './kit.ts';
import { RefusedError } from './runtime.ts';

describe('checkedNextConfig', () => {
  it('reads back a config that loads cleanly', () => {
    assert.deepEqual(checkedNextConfig({ sessions: ['lead', 'alpha'], roles: { lead: 'lead' } }).sessions, ['lead', 'alpha']);
  });

  it('refuses a config that would not load, or would load with a problem', () => {
    assert.throws(() => checkedNextConfig({ configVersion: 'x', sessions: ['lead'] }), (error: unknown) => error instanceof RefusedError && /^the new config cannot be read: configVersion/.test(error.message));
    assert.throws(() => checkedNextConfig({ sessions: ['lead', 'alpha'], roles: { lead: 'ghost' } }), (error: unknown) => error instanceof RefusedError && /^nothing written: roles\.lead/.test(error.message));
  });
});

describe('leadOrDeliveryOwnerOnly', () => {
  const roster = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead', deliveryOwner: 'alpha' } }, 'app');

  it('passes the lead and the delivery owner, by id or name', () => {
    assert.deepEqual([leadOrDeliveryOwnerOnly(roster, 'captain', 'x', {}), leadOrDeliveryOwnerOnly(roster, 'alpha', 'x', {})], ['lead', 'alpha']);
  });

  it('refuses anyone else, naming both roles’ holders, or the lead alone with no delivery owner', () => {
    const refused = (by: Roster, message: string) => assert.throws(() => leadOrDeliveryOwnerOnly(by, 'bravo', 'freezes the pipeline', {}), (error: unknown) => error instanceof RefusedError && error.message === message);
    refused(roster, 'only the lead or the delivery owner (captain, app-alpha) freezes the pipeline');
    refused(new Roster({ sessions: ['lead', 'bravo'], names: {}, roles: { lead: 'lead' } }, 'app'), 'only the lead or the delivery owner (app-lead) freezes the pipeline');
  });
});

describe('leadOnly', () => {
  const roster = new Roster({ sessions: ['lead', 'alpha'], names: { lead: 'captain' }, roles: { lead: 'lead' } }, 'app');
  const refused = (caller: string, env: Record<string, string>, message: string) =>
    assert.throws(() => leadOnly(roster, caller, 'changes the team config', env), (error: unknown) => error instanceof RefusedError && error.message === message);

  it('passes the lead from its own tab, by id or name, and from a terminal with no session set', () => {
    assert.deepEqual(
      [leadOnly(roster, 'lead', 'x', { TEAMRIG_SESSION: 'lead' }), leadOnly(roster, 'lead', 'x', { TEAMRIG_SESSION: 'captain' }), leadOnly(roster, 'captain', 'x', {}), leadOnly(roster, 'lead', 'x', { TEAMRIG_SESSION: ' ' })],
      ['lead', 'lead', 'lead', 'lead'],
    );
  });

  it("refuses a --session naming the lead from another session's tab, or from a tab of no session on the team", () => {
    refused('lead', { TEAMRIG_SESSION: 'alpha' }, 'this tab is alpha, not captain: changes the team config only from its own session\'s tab');
    refused('captain', { TEAMRIG_SESSION: 'ghost' }, 'this tab is ghost, not captain: changes the team config only from its own session\'s tab');
  });

  it('refuses a member in its own tab as not the lead', () => {
    refused('alpha', { TEAMRIG_SESSION: 'alpha' }, 'only the lead (captain) changes the team config');
  });
});

describe('leadOrDeliveryOwnerOnly from a tab', () => {
  it("refuses the delivery owner's id from another session's tab", () => {
    const roster = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: {}, roles: { lead: 'lead', deliveryOwner: 'alpha' } }, 'app');
    assert.equal(leadOrDeliveryOwnerOnly(roster, 'alpha', 'x', { TEAMRIG_SESSION: 'alpha' }), 'alpha');
    assert.throws(() => leadOrDeliveryOwnerOnly(roster, 'alpha', 'freezes the pipeline', { TEAMRIG_SESSION: 'bravo' }), (error: unknown) => error instanceof RefusedError && /^this tab is bravo, not app-alpha: freezes the pipeline/.test(error.message));
  });
});
