import type { PushedState } from '../issues/pushed-record.ts';
import type { PushedStore } from '../issues/recording-host.ts';

/** A pushed record kept in memory: `state` is what a file would hold, `updates` how often it was written. */
export class FakePushedStore implements PushedStore {
  updates = 0;
  state: PushedState;

  constructor(state: PushedState = new Map()) {
    this.state = state;
  }

  read(): Promise<PushedState> {
    return Promise.resolve(this.state);
  }

  update(change: (state: PushedState) => PushedState): Promise<void> {
    this.state = change(this.state);
    this.updates += 1;
    return Promise.resolve();
  }
}
