import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the console module decided never to throw. */
export const consoleNeverThrow: readonly IrLibFn[] = [
  // Console instance state that answers text: the timer labels are already
  // strings, the stores are the instance's own tables, and no program code
  // runs. (The counters and the table can throw, so they are not here.)
  "console.channelActive",
  "console.publishArgs",
  "console.instTime",
  "console.instTimeEnd",
  "console.instTimeLog",
  // scr_console_inst_group adjusts the instance's indentation count.
  "console.instGroup",
  // scr_console_inst_clear writes the terminal sequences to the instance's
  // descriptor; a non-terminal target writes nothing.
  "console.instClear",
];
