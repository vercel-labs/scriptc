import { DYN, F64 } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The ah builtin call slots. */
export const ahSignatures = defineLibFnSignatures({
  /** node:async_hooks (scr_async_dyn.c): createHook(callbacks) validates
   * its five callbacks with Node's ERR_ASYNC_CALLBACK and answers a 1-based
   * AsyncHook handle (MAY THROW); enable/disable answer the handle;
   * executionId/triggerId read the execution's ids. The ids are scriptc's
   * own sequence (Node's counter also numbers its module loading). */
  "ah.createHook": { argTypes: [DYN], result: F64 },
  /** createHook over an inline literal's five callbacks (each DYN,
   * undefined for an absent member): the literal converts member by
   * member, so a function member boxes as the checked-dynamic function
   * the registry calls. */
  "ah.createHookParts": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: F64 },
  "ah.enable": { argTypes: [F64], result: F64 },
  "ah.disable": { argTypes: [F64], result: F64 },
  /** asyncWrapProviders: Node's provider-name → id table as a
   * null-prototype checked-dynamic object (scr_ah_providers builds it; no
   * program code runs, and a compiled binary has no provider ids of its
   * own — the value is Node's published table). */
  "ah.providers": { argTypes: [], result: DYN },
  "ah.executionId": { argTypes: [], result: F64 },
  "ah.triggerId": { argTypes: [], result: F64 },
  /** executionAsyncResource(): the AsyncResource whose runInAsyncScope or
   * bound call is executing, and a shared plain object elsewhere (timer,
   * immediate, tick and promise executions have no resource object of
   * their own in the runtime). */
  "ah.executionResource": { argTypes: [], result: DYN },
});
