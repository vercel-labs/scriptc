import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The error builtin call slots. */
export const errorSignatures = defineLibFnSignatures({
  /** The compiler-resolved ERR_INVALID_ARG_TYPE throw with a RUNTIME-
   * rendered Received tail: args [argname, "of type ..." clause, the
   * offending dyn value]. ALWAYS THROWS; polymorphic result (the
   * error.nodeThrow pattern). May-throw seed. */
  "error.argTypeThrow": { argTypes: [STRING, STRING, DYN], result: VOID },
  /** The property flavor of argTypeThrow ("The \"options.x\" property
   * must be ..."): the option-bag ladders' provably-invalid arms. ALWAYS
   * THROWS; polymorphic result. May-throw seed. */
  "error.propTypeThrow": { argTypes: [STRING, STRING, DYN], result: VOID },
  // error.new's result and the receiver slots are builtin-error classes —
  // program-dependent object types, checked in the libCall case.
  /** The runtime-provided Error hierarchy's entry points (scr_error.c).
   * error.new: one borrowed string arg (the message), result an owned (+1)
   * builtin error instance — the result TYPE names which builtin class
   * (backends derive the runtime kind from it). error.ctor: the
   * super(message) call of an `extends Error` constructor — borrowed
   * receiver (already allocated by the derived class's new) + borrowed
   * message, void; the receiver's type names the builtin class whose name
   * field to stamp. Both may omit the message: `new Error()` and `super()`
   * create no own message property. Source constructions take these typed
   * entries when the message is a native string or absent and no options
   * argument is passed; every other form takes error.newOptions and
   * error.ctorOptions. error.toString: borrowed `%Error`-typed receiver, +1
   * string in Node's "name: message" shape. Formatting can invoke a user
   * message accessor, which can throw. */
  "error.new": { argTypes: [STRING], result: VOID },
  /** ECMAScript constructors with raw checked-dynamic message/options.
   * Options retain cause presence; constructor calls borrow their args.
   * Message coercion may throw before the cause is installed. */
  "error.newOptions": { argTypes: [DYN, DYN], result: VOID },
  "error.captureStackTrace": { argTypes: [DYN, STRING, BOOL], result: VOID },
  "error.ctorOptions": { argTypes: [null, DYN, DYN], result: VOID },
  /** Borrowed Error receiver. cause returns an owned dyn value (undefined
   * when absent); hasCause distinguishes absence from present undefined. */
  "error.cause": { argTypes: [null], result: DYN },
  "error.hasCause": { argTypes: [null], result: BOOL },
  /** Assignment borrows both operands and retains the new cause. */
  "error.setCause": { argTypes: [null, DYN], result: VOID },
  /** `err.code = s` on an error-hierarchy receiver: the code slot that
   * error.code reads and coded throws stamp. Borrows both; never throws. */
  "error.setCode": { argTypes: [null, STRING], result: VOID },
  /** `err.code = v` with a value that is not statically a string: strings
   * take the code slot, anything else clears it and sets the dynamic own
   * property. Borrows both; never throws. */
  "error.setCodeDyn": { argTypes: [null, DYN], result: VOID },
  /** `Object.assign(err, ...sources)` onto an error-hierarchy receiver
   * (args: the error, a dyn array of the sources): the own-member copy
   * onto its checked-dynamic node, then the typed slots (name, message,
   * stack, cause, code) re-read from it. Throws what the copy throws. */
  "error.assign": { argTypes: [null, DYN], result: VOID },
  /** `key in err` for a key no compiled class of the receiver declares
   * (args: the error, the key): a runtime-set own property (Object.assign,
   * throw-site fields, dynamic writes) or an Object.prototype member. */
  "error.hasKey": { argTypes: [null, STRING], result: BOOL },
  "error.hasCode": { argTypes: [null], result: BOOL },
  /** Whether the error's own `name` or `message` (the key) is an accessor
   * a reflective definition installed. Borrows both; never throws. */
  "error.ownAccessor": { argTypes: [null, STRING], result: BOOL },
  /** That accessor's getter called on the error (owned result), and its
   * setter called with the value (V8's TypeError without one). Borrow
   * their arguments; throw what the accessor throws. */
  "error.accessorGet": { argTypes: [null, STRING], result: DYN },
  "error.accessorSet": { argTypes: [null, STRING, DYN], result: VOID },
  "error.defineCause": { argTypes: [null, DYN], result: VOID },
  "error.deleteCause": { argTypes: [null], result: VOID },
  /** The compiler-resolved Node-parity throw for always-throwing lowered
   * arms (ERR_INVALID_THIS receivers, ERR_MISSING_ARGS arity ladders,
   * the symbol-to-string TypeError): args are [error-kind f64 (the
   * SCR_ERR_* index: 0 Error, 1 TypeError, 2 RangeError), code (empty =
   * no code slot), message], and optionally a fourth string, the error's
   * own `url` property (ir/validate.ts accepts it). ALWAYS THROWS
   * catchably; the result type is the replaced expression's own (never
   * materialized — the global.undefRead pattern). May-throw seed. */
  "error.nodeThrow": { argTypes: [F64, STRING, STRING], result: VOID },
  "error.ctor": { argTypes: [null, STRING], result: VOID },
  "error.toString": { argTypes: [null], result: STRING },
  "error.stack": { argTypes: [null], result: STRING },
  "error.setStack": { argTypes: [null, STRING], result: VOID },
  "error.stackLimitGet": { argTypes: [], result: F64 },
  "error.stackLimitSet": { argTypes: [F64], result: VOID },
  "error.prepareStackTraceGet": { argTypes: [], result: DYN },
  "error.prepareStackTraceSet": { argTypes: [DYN], result: VOID },
  // Receiver (any error-hierarchy object) and the program-dependent
  // `string | undefined` result are checked in the libCall case.
  /** NodeJS.ErrnoException's `.code` read: borrowed error-hierarchy
   * receiver → the interned `string | undefined` union (type-directed
   * construction in the backend, the process.envGet pattern) — the errno
   * name where a throw site stamped one (fs, exec spawn/timeout,
   * process.kill, the spawn 'error' event), the undefined arm everywhere
   * else. Never throws. */
  "error.code": { argTypes: [null], result: VOID },
  // DOMException: construction takes the two dyn args (WebIDL's
  // resolution runs in the runtime); the %DOMException result is a
  // program-dependent object type, checked in the libCall case. The
  // read surface takes the %DOMException receiver (a null slot — the
  // libCall case checks the class name).
  /** `new DOMException(message?, nameOrOptions?)` (scr_error.c): both args
   * are borrowed dyn values (the lowering passes the dyn undefined for an
   * absent argument, so WebIDL's optionality lives in one place). The
   * runtime ToStrings the message ("" for absent/undefined), resolves the
   * name — absent/undefined → "Error", a non-null object → ToString of its
   * `name` member plus the `cause` own-property record, anything else →
   * ToString — and stamps the legacy code from the WebIDL name table (0
   * off-table). Result is an owned (+1) %DOMException. Never throws (dyn
   * ToString is total). */
  "error.newDom": { argTypes: [DYN, DYN], result: VOID },
  /** DOMException's own read surface (scr_error.c; %DOMException receivers
   * only — borrowed). domCode: the legacy numeric code. domHasCause: the
   * options form's own-property record (`'cause' in e`). domCause: the
   * cause value, +1 (the dyn undefined when absent — matching Node's
   * undefined read). None throws. */
  "error.domCode": { argTypes: [null], result: F64 },
  "error.domHasCause": { argTypes: [null], result: BOOL },
  "error.domCause": { argTypes: [null], result: DYN },
  /** structuredClone of a %DOMException receiver (scr_error.c): WebIDL
   * serialization — name/message copy, the legacy code re-derives, cause
   * does not serialize. args are the borrowed receiver and the borrowed
   * options dyn value (the dyn undefined when absent — the shared
   * validation throws Node's exact option errors; any non-empty transfer
   * list throws DataCloneError, nothing static is transferable). Result
   * +1 %DOMException. */
  "error.domClone": { argTypes: [null, DYN], result: VOID },
  /** `new AggregateError(errors, message?, options?)` (scr_json.c), in
   * spec order: newAggregate installs the message and cause (both dyn,
   * borrowed — the message conversion can throw) and returns an owned
   * %AggregateError; aggregateSetErrors then stores the iterated list
   * (borrowed receiver, the dyn array borrowed and retained).
   * aggregateErrors reads the list (+1, the same array every read). */
  "error.newAggregate": {
    argTypes: [DYN, DYN],
    result: { kind: "object", className: "%AggregateError" },
  },
  "error.aggregateSetErrors": { argTypes: [null, DYN], result: VOID },
  "error.aggregateErrors": { argTypes: [null], result: DYN },
  /** `new SuppressedError(error, suppressed, message?)` (scr_json.c): all
   * three dyn and borrowed; the message conversion can throw. Returns an
   * owned %SuppressedError. */
  "error.newSuppressed": {
    argTypes: [DYN, DYN, DYN],
    result: { kind: "object", className: "%SuppressedError" },
  },
});
