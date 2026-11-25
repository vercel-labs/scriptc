import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the child module decided never to throw. */
export const childNeverThrow: readonly IrLibFn[] = [
  // subprocess.channel answers the child's IPC state: undefined when it
  // never had a channel, null once it closed, else a handle over the
  // child. The island path reads the island ChildProcess's `channel`
  // data property, which Node assigns as a field; neither path runs an
  // accessor, a coercion or a callback.
  "child.channel",
  // child.stdio's length is the child's fixed stdio slot count: a plain
  // read of the handle's field, with no allocation and no program code.
  "child.stdioLen",
  // The child's cached stdio array: a flag read, a retain of the array the
  // first read built, and a store of that array (a retain); no program code.
  "child.stdioCached",
  "child.stdioArray",
  "child.stdioStore",
  // spawnSync's result.pid is a plain number read off the result handle:
  // no allocation and no program code.
  "spawnRes.pid",
  // Node's shell form command line: a string join; the DEP0190 report is
  // deferred to its own tick, so the call itself raises nothing.
  "child.shellCommand",
];
