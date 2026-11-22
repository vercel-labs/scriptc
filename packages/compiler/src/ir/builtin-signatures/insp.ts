import { arrayOf, BOOL, BYTES_U8, DATE_T, DYN, F64, REGEX, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The insp builtin call slots. */
export const inspSignatures = defineLibFnSignatures({
  // util.inspect: the error receiver is program-dependent (a builtin or
  // user error class — the error.toString precedent, null slot).

  "insp.f64": { argTypes: [F64], result: STRING },
  /** util.format %j over a checked-dynamic argument: the runtime dyn
   * walk (JS-exact stringify; root undefined/function prints
   * "undefined"; a handle in the tree throws the "not supported yet"
   * Error). */
  "insp.jsonDyn": { argTypes: [DYN], result: STRING },
  /** util.format %j over the value a toJSON hook returned: the same walk
   * starting at the write step, so the hook never runs over its own
   * result. */
  "insp.jsonDynValue": { argTypes: [DYN], result: STRING },
  "insp.str": { argTypes: [STRING], result: STRING },
  "insp.regex": { argTypes: [REGEX], result: STRING },
  /** A Date's inspect text: toISOString(), or "Invalid Date". */
  "insp.date": { argTypes: [DATE_T], result: STRING },
  "insp.buffer": { argTypes: [BYTES_U8], result: STRING },
  /** A numeric typed array that is not a Buffer (any element kind). */
  "insp.typedArray": { argTypes: [null, F64, F64], result: STRING },
  /** A u8 byte view in a union arm, element or field: a DataView, Buffer
   * or Uint8Array by its own flags. */
  "insp.bytes": { argTypes: [null, F64, F64], result: STRING },
  "insp.error": { argTypes: [null, F64, F64], result: STRING },
  "insp.errorHasCause": { argTypes: [null], result: BOOL },
  "insp.errorBagHasProperties": { argTypes: [DYN], result: BOOL },
  "insp.errorCause": { argTypes: [null, F64, F64], result: STRING },
  "insp.dyn": { argTypes: [DYN, F64, F64], result: STRING },
  "insp.dynS": { argTypes: [DYN, F64], result: STRING },
  /** util.format over a dyn array of its arguments, and
   * util.formatWithOptions(options, pack): the runtime formatter for format
   * strings known at run time and spread arguments. */
  "insp.format": { argTypes: [DYN], result: STRING },
  /** The console channels' formatter: insp.format over a private copy of
   * the published arguments, so a subscriber's reentrant mutation of the
   * array cannot free the vector the formatter reads. */
  "insp.formatSnapshot": { argTypes: [DYN], result: STRING },
  /** insp.format over arguments that are all strings, numbers, booleans,
   * null or undefined, without the checked-dynamic walk. */
  "insp.formatPrimitives": { argTypes: [arrayOf(DYN)], result: STRING },
  "insp.formatList": { argTypes: [arrayOf(DYN)], result: STRING },
  "insp.formatWithOptions": { argTypes: [DYN, DYN], result: STRING },
  /** util.inspect(value, options, depth, colors) with the call's argument
   * count: the runtime reads the options and renders the checked-dynamic
   * view. */
  "insp.inspect": { argTypes: [DYN, DYN, DYN, DYN, F64], result: STRING },
  "insp.inspectDir": { argTypes: [DYN, DYN, F64], result: STRING },
  /** A [util.inspect.custom] method's call: whether ctx.customInspect is
   * set, its depth argument (the remaining depth at recursion r of depth
   * d), its options object and util.inspect, then its result rendered: a
   * string re-indented at the current level, or a checked-dynamic value
   * (customIsSelf tests for the instance itself). customInspect sets the
   * flag for the renders that follow and answers the previous value, and
   * depthKind does the same for how an unbounded depth was given (0
   * Infinity, 1 null, 2 undefined). */
  "insp.customEnabled": { argTypes: [], result: BOOL },
  /** Registers a class's compiled custom inspect function under its
   * instances' typed-ref type key, for the checked-dynamic walk. */
  "insp.registerCustom": { argTypes: [STRING, DYN], result: VOID },
  "insp.customInspect": { argTypes: [BOOL], result: BOOL },
  "insp.depthKind": { argTypes: [F64], result: F64 },
  "insp.customDepth": { argTypes: [F64, F64], result: DYN },
  "insp.customOptions": { argTypes: [F64], result: DYN },
  "insp.inspectFunction": { argTypes: [], result: DYN },
  "insp.customText": { argTypes: [STRING], result: STRING },
  "insp.customIsSelf": { argTypes: [DYN, DYN], result: BOOL },
  "insp.customResult": { argTypes: [DYN, F64, F64], result: STRING },
  /** Around the method's call: the inspect and format calls it makes run
   * in a fresh inspect context with the default options. begin answers the
   * token end takes; end also discards what a call that threw left. */
  "insp.customCallBegin": { argTypes: [], result: F64 },
  "insp.customCallEnd": { argTypes: [F64], result: VOID },
  /** Whether a runtime format string has a '%' before its last character. */
  "insp.formatSpecifies": { argTypes: [STRING], result: BOOL },
  "insp.formatSpecifiesDyn": { argTypes: [DYN], result: BOOL },
  "insp.dynFormatS": { argTypes: [DYN, F64], result: STRING },
  /** util.format's %o over a checked-dynamic value: inspect with
   * showHidden. Kinds whose hidden entries have no rendering throw the
   * 'not supported yet' Error. */
  "insp.dynHidden": { argTypes: [DYN, F64], result: STRING },
  "insp.begin": { argTypes: [F64], result: VOID },
  /** util.inspect's breakLength, compact (-1 for false), sorted and
   * maxArrayLength (Infinity for null) for the renders that follow; the
   * call site restores 80, 3, false and 100 afterwards. */
  "insp.layout": { argTypes: [F64, F64, BOOL, F64], result: VOID },
  /** The render's maxArrayLength, which the array, Map and Set traversals
   * read: the option applies at every nesting level. */
  "insp.maxArrayLength": { argTypes: [], result: F64 },
  "insp.numericSeparator": { argTypes: [BOOL], result: BOOL },
  /** ctx.maxStringLength for the renders that follow; answers the previous
   * value so the call site can restore it. */
  "insp.maxStringLength": { argTypes: [F64], result: F64 },
  /** ctx.getters for the renders that follow: whether an accessor
   * property's getter runs (0 the labels only, 1 every getter, 2 the
   * getters without a setter, 3 the getters with one); answers the previous
   * value so the call site can restore it. */
  "insp.getters": { argTypes: [F64], result: F64 },
  /** The current ctx.getters, which the interned per-type helpers read: the
   * option is run-time state shared by every call site. */
  "insp.gettersMode": { argTypes: [], result: F64 },
  /** An invoked accessor property's value, by the result's kind:
   * `[Label: <primitive>]` or `[Label] <object>`. */
  "insp.accessorValue": { argTypes: [DYN, STRING, F64, F64], result: STRING },
  "insp.entry": { argTypes: [STRING, BOOL], result: VOID },
  // Circular references: the receiver slot is program-dependent (any
  // cycle-capable record/array/map/class type — the insp.error precedent).
  /* Circular references over cycle-capable composites (recursive record/
   * class types): circCheck answers a value's circular id when it is
   * already on the traversal stack (0 otherwise), seenPush/refWrap
   * bracket the frame (insp.end adds Node's "<ref *N> " prefix to values
   * the walk found circular), circular renders "[Circular *N]". */
  "insp.circCheck": { argTypes: [null], result: F64 },
  "insp.seenPush": { argTypes: [null], result: VOID },
  "insp.refWrap": { argTypes: [null, STRING], result: STRING },
  "insp.circular": { argTypes: [F64], result: STRING },
  "insp.key": { argTypes: [STRING], result: STRING },
  "insp.property": { argTypes: [STRING, STRING, BOOL], result: STRING },
  "insp.propChild": { argTypes: [BOOL], result: VOID },
  "insp.moreItems": { argTypes: [F64], result: STRING },
  "insp.end": { argTypes: [STRING, STRING, STRING, F64, BOOL, BOOL], result: STRING },
  /** A nested inspect inside a custom rendering (PerformanceEntry's
   * `${name} ${inspect(toJSON)}`): nestedBegin starts a fresh inspect
   * context, nestedEnd(prefix, inner) restores the caller's and answers
   * `prefix inner` re-indented at the caller's level (+1). */
  "insp.nestedBegin": { argTypes: [], result: VOID },
  "insp.nestedEnd": { argTypes: [STRING, STRING], result: STRING },
  /** nestedEnd's restore alone: the caller's context returns. */
  "insp.nestedRestore": { argTypes: [], result: VOID },
  /** Around a top-level render that an inspection refusal can end: mark
   * records the inspector's frame and nesting depth, unwind (in the
   * render's finally) closes what the render left open above it. */
  "insp.mark": { argTypes: [], result: VOID },
  "insp.unwind": { argTypes: [], result: VOID },
});
