import { arrayOf, BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The rl builtin call slots. */
export const rlSignatures = defineLibFnSignatures({
  // node:readline: the interface handle is f64; the callbacks' func types
  // are program-dependent (the emitter picks the adapter by parameter
  // count), so those slots are null like child.onExit's.
  /** node:readline and node:readline/promises (scr_readline.c, linked
   * under the events gate — these fns imply moduleUsesProcessEvents; a
   * stream input or output adds scr_stream.c's bridge). The interface
   * value is an f64 handle (the Timeout-id precedent); an open interface
   * on stdin keeps the loop alive until close/EOF.
   * rl.create: [mode, input?, output?, crlfDelay, prompt?] → f64, mode
   * bits 1 stream input, 2 stream output, 4 stdout output, 16 prompt
   * (lowerReadlineCreateCall); rl.createSignal: the same plus the
   * trailing AbortSignal (mode bit 8), which links the event-target unit
   * for addAbortListener. rl.question: [handle, query, cb] — the callback
   * form; THROWS ERR_USE_AFTER_CLOSE on a closed interface (may-throw).
   * rl.questionAsync(Signal): [handle, query, signal?] → promise<string>,
   * rejecting instead of throwing. rl.close/pause/resume/prompt:
   * [handle] (pause/resume/prompt throw ERR_USE_AFTER_CLOSE when
   * closed); rl.setPrompt/getPrompt; rl.write: [handle, data] (throws
   * when closed). rl.on: [handle, event, cb, once] — the event number
   * (0 'line', 1 'close', 2 'pause', 3 'resume', 4 'error') and the
   * listener (moves). rl.iterOpen/iterNext/iterReturn: the async
   * iterator — iterNext answers promise<dyn> of the line or undefined. */
  "rl.create": { argTypes: [F64], result: F64 },
  "rl.createSignal": { argTypes: [F64], result: F64 },
  "rl.question": { argTypes: [F64, STRING, null], result: VOID },
  "rl.questionAsync": { argTypes: [F64, STRING], result: { kind: "promise", inner: STRING } },
  "rl.questionAsyncSignal": {
    argTypes: [F64, STRING, DYN],
    result: { kind: "promise", inner: STRING },
  },
  /** The question forms with a checked-dynamic query (a JavaScript value
   * that need not be a string). */
  "rl.questionDyn": { argTypes: [F64, DYN, null], result: VOID },
  "rl.questionAsyncDyn": { argTypes: [F64, DYN], result: { kind: "promise", inner: STRING } },
  "rl.questionAsyncSignalDyn": {
    argTypes: [F64, DYN, DYN],
    result: { kind: "promise", inner: STRING },
  },
  "rl.close": { argTypes: [F64], result: VOID },
  "rl.pause": { argTypes: [F64], result: VOID },
  "rl.resume": { argTypes: [F64], result: VOID },
  "rl.prompt": { argTypes: [F64], result: VOID },
  /** prompt(preserveCursor): [handle, preserveCursor] */
  "rl.promptWith": { argTypes: [F64, BOOL], result: VOID },
  "rl.setPrompt": { argTypes: [F64, STRING], result: VOID },
  "rl.setPromptDyn": { argTypes: [F64, DYN], result: VOID },
  "rl.getPrompt": { argTypes: [F64], result: STRING },
  /** getPrompt() for a checked-dynamic use: the stored prompt value
   * itself (a number or object set through an untyped setPrompt keeps its
   * identity). */
  "rl.getPromptDyn": { argTypes: [F64], result: DYN },
  "rl.write": { argTypes: [F64, STRING], result: VOID },
  /** write(data, key): [handle, hasData, data, hasKey, hasName, name,
   * ctrl, meta, shift] */
  "rl.writeKey": {
    argTypes: [F64, BOOL, STRING, BOOL, BOOL, STRING, BOOL, BOOL, BOOL],
    result: VOID,
  },
  "rl.on": { argTypes: [F64, F64, null, BOOL], result: VOID },
  "rl.onFirst": { argTypes: [F64, F64, null, BOOL], result: VOID },
  "rl.off": { argTypes: [F64, F64, null], result: VOID },
  "rl.offAll": { argTypes: [F64, F64], result: VOID },
  "rl.listenerCount": { argTypes: [F64, F64], result: F64 },
  "rl.listenerCountFn": { argTypes: [F64, F64, null], result: F64 },
  "rl.eventNames": { argTypes: [F64], result: arrayOf(STRING) },
  "rl.iterOpen": { argTypes: [F64], result: VOID },
  "rl.iterNext": { argTypes: [F64], result: { kind: "promise", inner: DYN } },
  "rl.iterReturn": { argTypes: [F64], result: VOID },
  /** createInterface's history and editing options (scr_rl_check_options:
   * [flags, tabSize, escapeCodeTimeout, historySize], may throw;
   * rl.setOptions: [handle, flags, historySize, removeHistoryDuplicates,
   * tabSize, escapeCodeTimeout]; rl.setHistory: [handle, history]) and
   * the member reads (rl.history answers the array, rl.numProp the
   * numeric member by number). */
  "rl.checkOptions": { argTypes: [F64, F64, F64, F64], result: VOID },
  "rl.checkCompleter": { argTypes: [DYN], result: VOID },
  "rl.setOptions": { argTypes: [F64, F64, F64, BOOL, F64, F64], result: VOID },
  "rl.setHistory": { argTypes: [F64, arrayOf(STRING)], result: VOID },
  "rl.history": { argTypes: [F64], result: arrayOf(STRING) },
  "rl.numProp": { argTypes: [F64, F64], result: F64 },
  /** Terminal mode (scr_readline_tty.c): rl.terminal: [handle, mode (0
   * the option's value, 2 output.isTTY of process.stdout), terminal,
   * completer (undefined when absent), readline/promises], emitted with
   * scr_insp_dyn when there is a completer; the line, terminal and cursor
   * members. */
  "rl.terminal": { argTypes: [F64, F64, BOOL, DYN, BOOL], result: VOID },
  "rl.line": { argTypes: [F64], result: STRING },
  "rl.isTerminal": { argTypes: [F64], result: BOOL },
  "rl.isPromises": { argTypes: [F64], result: BOOL },
  /** createInterface's input or output as a checked-dynamic value:
   * [value, output] — the stream; refused when it is not one. */
  "rl.inputFromDyn": {
    argTypes: [DYN, BOOL],
    result: { kind: "object", className: "%Readable" },
  },
  "rl.outputFromDyn": {
    argTypes: [DYN, BOOL],
    result: { kind: "object", className: "%Writable" },
  },
  "rl.cursor": { argTypes: [F64], result: F64 },
  /** readline.cursorTo / moveCursor / clearLine / clearScreenDown: rl.seq
   * [kind (0-3), the first and second numbers, whether the second is
   * given] answers the data to write after the argument checks (may
   * throw); rl.moves [dx, dy] says whether moveCursor writes. */
  "rl.seq": { argTypes: [F64, F64, F64, BOOL], result: STRING },
  "rl.moves": { argTypes: [F64, F64], result: BOOL },
  /** getCursorPos() (scr_readline_tty.c, linked through the regex unit
   * like rl.terminal): [handle, 0 rows | 1 cols] */
  "rl.cursorPos": { argTypes: [F64, F64], result: F64 },
  /** readline.emitKeypressEvents (scr_readline_tty.c): rl.keypressStdin
   * [interface (0: none), escapeCodeTimeout (NaN: the interface's or
   * 500)], rl.keypressStream [stream, interface, timeout]. */
  "rl.keypressStdin": { argTypes: [F64, F64], result: VOID },
  "rl.keypressStream": { argTypes: [null, F64, F64], result: VOID },
  /** readline/promises Readline over an f64 handle: rl.uiOpen [fd (1
   * stdout, 2 stderr), autoCommit], rl.uiOpenStream [stream, autoCommit]
   * (isWritable, may throw); the actions take [handle, ...numbers] (the
   * checks may throw; cursorTo: [handle, x, whether y is given, y]);
   * rl.uiCommit answers a promise<void>. */
  "rl.uiOpen": { argTypes: [F64, BOOL], result: F64 },
  "rl.uiOpenStream": { argTypes: [null, BOOL], result: F64 },
  "rl.uiCursorTo": { argTypes: [F64, F64, BOOL, F64], result: VOID },
  "rl.uiMoveCursor": { argTypes: [F64, F64, F64], result: VOID },
  "rl.uiClearLine": { argTypes: [F64, F64], result: VOID },
  "rl.uiClearScreenDown": { argTypes: [F64], result: VOID },
  "rl.uiRollback": { argTypes: [F64], result: VOID },
  "rl.uiCommit": { argTypes: [F64], result: { kind: "promise", inner: VOID } },
});
