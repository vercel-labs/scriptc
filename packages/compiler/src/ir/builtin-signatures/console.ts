import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The console builtin call slots. */
export const consoleSignatures = defineLibFnSignatures({
  "console.native": { argTypes: [], result: DYN },
  /** node:console Console instances (scr_console_native.c): new mints the
   * handle over the stdout/stderr fds (1/2; 0 = a stream binds next), the
   * ignoreErrors flag and the groupIndentation (a number, or null for
   * undefined: Node's validateInteger runs here); bind attaches a borrowed
   * writable stream to target 0 (stdout) or 1 (stderr); write prints
   * `text\n` to the selected target of an instance or the global console
   * handle. */
  "console.new": { argTypes: [F64, F64, BOOL, DYN, DYN, DYN], result: DYN },
  "console.bind": { argTypes: [DYN, F64, null], result: VOID },
  "console.write": { argTypes: [DYN, STRING, BOOL], result: VOID },
  /** The global console's remaining members (scr_console_native.c; the
   * group indentation itself lives with the writers in scr_console.c).
   * Arguments are borrowed; string results are owned. noop is the
   * emitter-dropped tail of a lowering whose effects sit in statements.
   * label is `${label}` over a defaulted label (undefined -> "default";
   * a Symbol throws Node's TypeError). count prints "label: n".
   * countReset answers the warning text for an unknown (or non-string)
   * label, "" otherwise. time answers the duplicate-label warning text
   * or ""; timeEnd/timeLog answer Node's formatted elapsed time, or ""
   * for an unknown label (timeEnd drops the timer). group adds (+1) or
   * removes (-1) one two-space indentation step. clear writes the
   * cursor-home and erase-down sequences when stdout is a terminal.
   * table renders and prints Node's table for a dyn value (undefined
   * properties = all). dirDyn is console.dir's inspect of a dyn value
   * (custom inspection off: a Buffer anywhere inside throws the fence). */
  "console.noop": { argTypes: [], result: VOID },
  /** A global console output member's diagnostics-channel publish: the
   * call's evaluated argument array (spreads expanded), published on
   * console.<member> (0 log, 1 info, 2 debug, 3 warn, 4 error) before the
   * line is written. Never throws: a subscriber's throw becomes the
   * channel's deferred uncaught report (scr_console.c). */
  "console.publishArgs": { argTypes: [F64, DYN], result: VOID },
  /** Whether console.<member> has a diagnostics-channel subscriber: the
   * guard around building the published argument array (scr_console.c). */
  "console.channelActive": { argTypes: [F64], result: BOOL },
  "console.label": { argTypes: [DYN], result: STRING },
  "console.count": { argTypes: [STRING], result: VOID },
  "console.countReset": { argTypes: [DYN], result: STRING },
  "console.time": { argTypes: [STRING], result: STRING },
  "console.timeEnd": { argTypes: [STRING], result: STRING },
  "console.timeLog": { argTypes: [STRING], result: STRING },
  "console.group": { argTypes: [F64], result: VOID },
  "console.clear": { argTypes: [], result: VOID },
  "console.table": { argTypes: [DYN, DYN], result: VOID },
  "console.dirDyn": { argTypes: [DYN, F64], result: STRING },
  "console.dirHidden": { argTypes: [DYN, F64], result: STRING },
  /** The same members on a Console instance (scr_console_native.c), which
   * keeps its own counters, timers and group indentation and writes to
   * its own stdout/stderr targets. count prints "label: n"; countReset
   * answers the warning text for an unknown (or non-string) label, ""
   * otherwise; time answers the duplicate-label warning text or "";
   * timeEnd/timeLog answer the formatted elapsed time, or "" for an
   * unknown label (timeEnd drops the timer). group adds (+1) or removes
   * (-1) one indentation step of the instance's groupIndentationWidth.
   * clear writes the cursor-home and erase-down sequences when the
   * instance's stdout is a terminal. table renders and prints Node's
   * table; trace prints "Trace[: text]" and the captured frames to the
   * instance's stderr. */
  "console.instCount": { argTypes: [DYN, STRING], result: VOID },
  "console.instCountReset": { argTypes: [DYN, DYN], result: STRING },
  "console.instTime": { argTypes: [DYN, STRING], result: STRING },
  "console.instTimeEnd": { argTypes: [DYN, STRING], result: STRING },
  "console.instTimeLog": { argTypes: [DYN, STRING], result: STRING },
  "console.instGroup": { argTypes: [DYN, F64], result: VOID },
  "console.instClear": { argTypes: [DYN], result: VOID },
  "console.instTable": { argTypes: [DYN, DYN, DYN], result: VOID },
  "console.instTrace": { argTypes: [DYN, STRING], result: VOID },
  /** The instance methods' run-time argument forms: a Console built with
   * inspectOptions or colorMode formats its checked-dynamic arguments with
   * util.formatWithOptions over the instance options and colorMode
   * (scr_inspect.c). writeArgs names an output member (0 log, 1 info,
   * 2 debug, 3 warn, 4 error); dirArgs renders console.dir for the
   * call's argc; assert and group follow Node's Console methods. */
  "console.instWriteArgs": { argTypes: [DYN, F64, DYN], result: VOID },
  "console.instDirxmlArgs": { argTypes: [DYN, DYN], result: VOID },
  "console.instDirArgs": { argTypes: [DYN, DYN], result: STRING },
  "console.instTraceArgs": { argTypes: [DYN, DYN], result: VOID },
  "console.instAssertArgs": { argTypes: [DYN, DYN], result: VOID },
  "console.instGroupArgs": { argTypes: [DYN, DYN, BOOL], result: VOID },
});
