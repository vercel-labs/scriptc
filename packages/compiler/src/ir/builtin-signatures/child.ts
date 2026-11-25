import { arrayOf, BOOL, CHILD_T, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The child builtin call slots. */
export const childSignatures = defineLibFnSignatures({
  "child.connected": { argTypes: [CHILD_T], result: BOOL },
  /** child.stdio's length: the child's stdio slot count (3, or 4 for a
   * fork's IPC slot). A plain read of the child's fixed slot count. */
  "child.stdioLen": { argTypes: [CHILD_T], result: F64 },
  /** child.stdio's one array per child: the first read stores the built
   * array (stdioStore) and every read answers it (stdioCached /
   * stdioArray, whose result is the call site's array type). */
  "child.stdioCached": { argTypes: [CHILD_T], result: BOOL },
  "child.stdioArray": { argTypes: [CHILD_T], result: VOID },
  "child.stdioStore": { argTypes: [CHILD_T, null], result: VOID },
  /** Node's shell form command line, [file, ...args].join(' '): the string
   * a shell runs with -c, reporting DEP0190 once when the list is not
   * empty. +1 string. */
  "child.shellCommand": { argTypes: [STRING, arrayOf(STRING)], result: STRING },
  "child.hasChannel": { argTypes: [CHILD_T], result: BOOL },
  "child.send": { argTypes: [CHILD_T, STRING], result: BOOL },
  "child.sendCb": { argTypes: [CHILD_T, STRING, null], result: BOOL },
  "child.disconnect": { argTypes: [CHILD_T], result: VOID },
  "child.onMessage": { argTypes: [CHILD_T, null, BOOL], result: VOID },
  "child.onDisconnect": { argTypes: [CHILD_T, null, BOOL], result: VOID },
  "child.onSpawn": { argTypes: [CHILD_T, null], result: VOID },
  /** Rest listeners use the checked function bridge to pack event arguments. */
  "child.onDyn": { argTypes: [CHILD_T, STRING, DYN], result: VOID },
  "child.propsDefine": { argTypes: [DYN, DYN, DYN], result: DYN },
  "child.propsDescriptor": { argTypes: [DYN, DYN], result: DYN },
  "child.propsResolve": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "child.propsOnDyn": { argTypes: [CHILD_T, STRING, DYN], result: VOID },
  // The callback's func type is program-dependent (zero params, or the
  // `number | null` union / the %Error class) — the libCall case checks
  // the shape; the slot here only pins arity and the child receiver.
  "child.onExit": { argTypes: [CHILD_T, null], result: VOID },
  "child.onClose": { argTypes: [CHILD_T, null], result: VOID },
  "child.onError": { argTypes: [CHILD_T, null], result: VOID },
  /** The remove-by-identity pairs (child.off/removeListener): the
   * listener argument is the closure VALUE that was registered —
   * BORROWED, compared by pointer and never retained (a value the
   * registry does not hold removes nothing). */
  "child.offSpawn": { argTypes: [CHILD_T, null], result: VOID },
  "child.offExit": { argTypes: [CHILD_T, null], result: VOID },
  "child.offClose": { argTypes: [CHILD_T, null], result: VOID },
  "child.offError": { argTypes: [CHILD_T, null], result: VOID },
  // The ChildProcess lifecycle members: pid/exitCode are program-dependent
  // unions (`number | undefined` / `number | null` — the libCall case
  // checks the arms, the spawnRes.status pattern).
  /** The ChildProcess lifecycle members (scr_child.c), Node's shapes
   * exactly (SEMANTICS.md has the pinned matrix). child.pid is the
   * checker's `number | undefined` (undefined = spawn failure) and
   * child.exitCode its `number | null` (null while running and after a
   * signal death; -errno once a spawn failure settled) — both unions are
   * type-directed constructions in the backend over a has/get runtime
   * pair, the spawnRes.status pattern. child.killed is Node's
   * sent-a-signal flag. child.kill sends while the child is un-reaped
   * (false after — Node's null-handle answer) and THROWS the
   * Unknown-signal TypeError on bad names (may-throw); killNum passes
   * numbers through (0 probes; never throws). child.unref drops the
   * child from the loop's keep-alive set — it is still reaped while the
   * loop runs for other reasons, and one the loop never reaps is left to
   * the OS at exit. All receivers borrowed. */
  "child.pid": { argTypes: [CHILD_T], result: VOID },
  "child.exitCode": { argTypes: [CHILD_T], result: VOID },
  // child.signalCode's result is the interned `string | null` union
  // (the terminating signal's name, null while running, after a normal
  // exit, and after a spawn failure) — the spawnRes.signal pattern.
  "child.signalCode": { argTypes: [CHILD_T], result: VOID },
  // The piped-output stream reads: `Readable | null` unions (the libCall
  // case checks the arms — the child.pid pattern with a ref arm).
  /** The piped-output streams (stdio mode 3 — scr_child.c's stream
   * slice). child.stdout/child.stderr answer the checker's
   * `Readable | null` union (type-directed construction in the backend
   * over the +1-or-NULL runtime pair — the child.pid pattern with a ref
   * arm). stream.onData/onEnd register 'data'/'end' listeners (receiver
   * borrowed, CALLBACK MOVES, trailing once-flag, void — chaining
   * fenced): 'data' fires one Buffer chunk per read (zero-param and
   * Buffer/string adapters are runtime-provided; setEncoding threads
   * split multibyte sequences through the shared StringDecoder core. A
   * union-param listener —
   * ngrok's `Buffer | string` — gets a compiler-emitted adapter wrapping
   * the chunk at its Buffer arm), 'end' fires once at EOF, always BEFORE
   * the child's 'exit' (the pinned ordering). A flowing stream keeps the
   * loop alive: usesTimers. */
  "child.stdout": { argTypes: [CHILD_T], result: VOID },
  "child.stderr": { argTypes: [CHILD_T], result: VOID },
  /** The piped-input writer (stdio mode 3 on fd 0). child.stdin answers
   * `Writable | null`; writes copy borrowed data into the nonblocking
   * queue, end/destroy settle it, writable is a pure state read, and
   * listener callbacks move into the writer registry. */
  "child.stdin": { argTypes: [CHILD_T], result: VOID },
  /** Under the general stream representation (general-streams.ts), a
   * stdio read (slot 0, 1 or 2) answers the child's bridged runtime stream
   * — `Writable | null` for stdin, `Readable | null` otherwise; the bridge
   * throws when the program lacks the stream unit's boxing helpers. */
  "child.stdioStream": { argTypes: [CHILD_T, F64], result: VOID },
  "child.killed": { argTypes: [CHILD_T], result: BOOL },
  /** spawnfile and spawnargs: the file the child was started from, and
   * that file followed by its arguments (Node's own reporting: a shell
   * spawn reports the shell and its invocation). Both are +1. */
  "child.spawnfile": { argTypes: [CHILD_T], result: STRING },
  "child.spawnargs": { argTypes: [CHILD_T], result: arrayOf(STRING) },
  "child.kill": { argTypes: [CHILD_T, STRING], result: BOOL },
  "child.killNum": { argTypes: [CHILD_T, F64], result: BOOL },
  /** child.kill's checked-dynamic signal: Node's sanitizeKillSignal at the
   * call (undefined is SIGTERM; a name or an integer is the signal; anything
   * else throws ERR_UNKNOWN_SIGNAL). */
  "child.killDyn": { argTypes: [CHILD_T, DYN], result: BOOL },
  /** ChildProcess[Symbol.dispose](): Node's dispose sends SIGTERM only
   * while `killed` is false. */
  "child.dispose": { argTypes: [CHILD_T], result: VOID },
  "child.unref": { argTypes: [CHILD_T], result: VOID },
  "child.ref": { argTypes: [CHILD_T], result: VOID },
  /** subprocess.channel: the checked-dynamic Control handle (undefined
   * without an IPC channel, null after a disconnect); the lowering
   * supplies its DYN type. */
  "child.channel": { argTypes: [CHILD_T], result: VOID },
});
