import { DYN, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The async builtin call slots. */
export const asyncSignatures = defineLibFnSignatures({
  /** AsyncLocalStorage (node:async_hooks — scr_async.c): stores are f64
   * handles; contexts are immutable fiber-carried snapshots (spawned
   * fibers inherit the spawner's — Node's init-time capture). run/exit
   * enter (or clear) the store, call the dyn function with forwarded
   * arguments, and restore (the finally); getStore answers the current
   * dyn value or undefined; enterWith installs with no restore point.
   * run/exit MAY THROW (the callback's own throws propagate). */
  /** `await v` over a checked-dynamic VALUE (scr_async.c): a dyn promise
   * adopts (rejections re-throw — MAY THROW), anything else takes JS's
   * one-microtask non-thenable await and answers itself. Only emitted
   * inside async bodies (the frontend's isAsync gate). */
  "async.awaitDyn": { argTypes: [DYN], result: DYN },
  /** The bare one-microtask hop (scr_await_hop): `await v` over a typed
   * NON-promise value — JS awaits non-thenables through exactly one
   * microtask turn and yields the value itself. Never throws. */
  "async.hop": { argTypes: [], result: VOID },
});
