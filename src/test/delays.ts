// Helpers for exploring machines with xstate/graph, including their delayed
// (`after`) transitions, which are ordinary events named
// `xstate.after.<ms>.<stateNodeId>`.
import type { AnyMachineSnapshot, EventObject } from 'xstate';

/** The `after` events that could fire from this snapshot's active states. */
export function delayedEvents(snapshot: AnyMachineSnapshot): EventObject[] {
  return snapshot._nodes.flatMap((node) => node.after.map((t) => ({ type: t.eventType })));
}

export const isDelayed = (e: EventObject) => e.type.startsWith('xstate.after.');
export const delayOf = (e: EventObject) => Number(e.type.split('.')[2]);
export const isInit = (e: EventObject) => e.type === 'xstate.init';
