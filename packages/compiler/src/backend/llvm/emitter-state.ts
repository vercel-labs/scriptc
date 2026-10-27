/* Per-feature emitter state. A feature defines its state in its own file
 * with defineModuleState and reads it through the returned key, so adding
 * or extending a feature does not edit LlEmitter's field list or
 * constructor. */
import type { LlEmitter } from "./emitter.js";

/** A feature's state on an emitter, read with `key.of(emitter)`. */
export interface EmitterStateKey<T> {
  of(emitter: LlEmitter): T;
}

let moduleSlots = 0;

/** State that lives for the whole module, created on first read. */
export function defineModuleState<T>(create: (emitter: LlEmitter) => T): EmitterStateKey<T> {
  const slot = moduleSlots++;
  return {
    of(emitter) {
      const states = emitter.moduleStates;
      if (slot >= states.length || states[slot] === undefined) states[slot] = create(emitter);
      return states[slot] as T;
    },
  };
}
