import { BIGINT_T, arrayOf, BOOL, DYN, F64, STRING, SYMBOL_T, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The dyn builtin call slots. */
export const dynSignatures = defineLibFnSignatures({
  /** Keyed WRITE on a dyn value — `h.onDone = cb` / `h["k"] = v` on a
   * checked-dynamic object (args: receiver, key string, value — all
   * borrowed; the runtime copies the key and retains the value in). An
   * OBJ receiver sets the member (later writes win, insertion order
   * preserved — JS exactly); undefined/null throws Node's catchable
   * "Cannot set properties of undefined (setting 'k')"; every other kind
   * throws Node's STRICT-mode "Cannot create property 'k' on <kind>" —
   * primitives quoting their rendering, V8's "on number '5'"
   * (sloppy mode would ignore the write — suite tests are 'use strict';
   * SEMANTICS.md notes the sloppy divergence: the write throws). Void
   * result; in the may-throw seed set. */
  "dyn.keySet": { argTypes: [DYN, STRING, DYN], result: VOID },
  "dyn.fnOwnSet": { argTypes: [DYN, STRING, DYN], result: VOID },
  "dyn.keySetComputed": { argTypes: [DYN, DYN, DYN], result: VOID },
  /** Delete an ordinary checked-native object's own key. Borrows both
   * arguments; other receiver representations retain a runtime refusal. */
  "dyn.keyDelete": { argTypes: [DYN, STRING, BOOL], result: VOID },
  "dyn.keyDeleteComputed": { argTypes: [DYN, DYN, BOOL], result: VOID },
  /** `delete` on a primitive base: ToPropertyKey of the key, then the
   * ToObject wrapper's own properties (a String's indexes and `length`
   * answer false in sloppy code and throw in strict code). Borrows both
   * operands; answers the delete's value. */
  "dyn.primitiveDelete": { argTypes: [DYN, DYN, BOOL], result: BOOL },
  "dyn.reflectDeleteProperty": { argTypes: [DYN, DYN], result: BOOL },
  /** Reflect.has's target check: Node's TypeError for a primitive. */
  "dyn.reflectHasTarget": { argTypes: [DYN], result: VOID },
  /** Reflect.getPrototypeOf's target check: Node's TypeError for any
   * primitive (Object.getPrototypeOf boxes instead). */
  "dyn.reflectGetPrototypeTarget": { argTypes: [DYN], result: VOID },
  "dyn.hasKeyComputed": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.hasOwnComputed": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.propertyIsEnumerableComputed": { argTypes: [DYN, DYN], result: BOOL },
  /** Native own properties on globalThis keyed by symbol identity. */
  "dyn.globalSymbolGet": { argTypes: [SYMBOL_T], result: DYN },
  "dyn.globalSymbolSet": { argTypes: [SYMBOL_T, DYN], result: VOID },
  "dyn.globalSymbolHas": { argTypes: [SYMBOL_T], result: BOOL },
  "dyn.globalSymbolDelete": { argTypes: [SYMBOL_T], result: VOID },
  /** Exact native class capsule identity, without materializing its fields,
   * for class dispatch: false for an instance Object.setPrototypeOf gave
   * another prototype, which dispatches through it. */
  "dyn.typedRefIs": { argTypes: [DYN, STRING], result: BOOL },
  /** Exact native class capsule identity whatever the instance's prototype
   * is: the brand a private member or a method's receiver checks. */
  "dyn.typedRefBrandIs": { argTypes: [DYN, STRING], result: BOOL },
  /** Whether Object.setPrototypeOf has replaced a live class instance's
   * prototype (scr_dyn_prototypes_replaced). */
  "dyn.prototypesReplaced": { argTypes: [], result: BOOL },
  /** Whether the value wraps a class instance whose prototype
   * Object.setPrototypeOf replaced. */
  "dyn.prototypeReplaced": { argTypes: [DYN], result: BOOL },
  /** A capsule boxed by this program from exactly this class: one key
   * pointer test, false for equal keys boxed elsewhere. Guards fast paths
   * whose fallback handles every other value. The key is a literal. */
  "dyn.typedRefKeyIs": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.classIs": { argTypes: [DYN, STRING], result: BOOL },
  /** A generated class table's indexed dispatch: the receiver's class key
   * folded to the case it selects, or -1 for a value that is not a capsule
   * or whose key is shorter than four bytes. The table switches on it and
   * keeps its exact key guards (frontend/lowering/class-dynamic-dispatch.ts). */
  "dyn.classHash": { argTypes: [DYN], result: F64 },
  /** A generated class table's case selector: the case number of the
   * class key the receiver's capsule matches under the exact test
   * `dyn.typedRefIs` applies, or 0 when it matches none. The second
   * argument is a string literal listing the table, one `<case> <key>`
   * line per class; classes whose branches are the same statements share
   * a case number (frontend/lowering/class-dynamic-dispatch.ts). The
   * backend switches on the key's dyn.classHash and confirms the one class
   * of that hash with a key-pointer compare (backend/llvm/lib-dispatch.ts). */
  "dyn.classCase": { argTypes: [DYN, STRING], result: F64 },
  /** The index of a table of class values (`dyn.classIs` branches: `x
   * instanceof C`, `new C()` and static members of an untyped
   * constructor): a function value's signature key folded to one of
   * 2^bits slots (the second argument, a literal), or -1 for a value that
   * is not a function or whose key is shorter than four bytes. A function
   * that is not a compiled class selects a slot only by coincidence, and
   * that slot's exact key guards are false for it. */
  "dyn.classValueHash": { argTypes: [DYN, F64], result: F64 },
  /** Destructuring pack over a dyn source — `const [a, b] = d`, a
   * destructured dyn callback param (args: the source and the STATIC
   * TypeError spelling, "" when the source has none — both borrowed;
   * result: a fresh dyn array, +1). Iterable kinds collect like spread
   * (arrays element-by-element, strings by code point, bytes by byte);
   * every other kind throws V8's destructuring TypeError — the spelling
   * verbatim when non-empty, else the runtime kind wording ("number 5 is
   * not iterable (cannot read property Symbol(Symbol.iterator))"). In the
   * may-throw seed set. */
  "dyn.iterPack": { argTypes: [DYN, STRING], result: DYN },
  "dyn.mathFold": { argTypes: [DYN, BOOL, STRING], result: F64 },
  /** Math.max/Math.min/Math.hypot over an argument list whose spread
   * operands are only known at run time: the values a call's argument
   * pack holds, each through ToNumber, folded in the pack's order (mode
   * 0 max, 1 min, 2 hypot). May throw: ToNumber can run valueOf. */
  "dyn.mathFoldMany": { argTypes: [DYN, F64], result: F64 },
  "dyn.destructureRest": { argTypes: [DYN, STRING], result: DYN },
  "dyn.arrayFromIterator": { argTypes: [DYN], result: DYN },
  "dyn.iterator": { argTypes: [DYN, STRING], result: DYN },
  /** for await over a checked-dynamic value: the loop's iterator (a
   * compiled async generator, Symbol.asyncIterator's result, or the sync
   * iterator), and whether that iterator is synchronous. */
  "dyn.asyncIteratorOpen": { argTypes: [DYN, STRING], result: DYN },
  "dyn.asyncIteratorWasSync": { argTypes: [], result: BOOL },
  "dyn.iteratorResult": { argTypes: [DYN], result: DYN },
  "dyn.iteratorCanStep": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.iteratorStep": { argTypes: [DYN], result: DYN },
  "dyn.iteratorStepDone": { argTypes: [DYN], result: BOOL },
  "dyn.setGeneratorMembers": { argTypes: [DYN, DYN, DYN], result: VOID },
  "dyn.iteratorHelperMethod": { argTypes: [STRING], result: DYN },
  "dyn.collectionIteratorIndex": { argTypes: [DYN], result: F64 },
  "dyn.mapSeedEntries": { argTypes: [DYN], result: DYN },
  "dyn.mapSeedEntry": { argTypes: [DYN], result: DYN },
  /** The for-of-over-dyn pack accessors — the emitted index loop drives
   * them over a dyn.iterPack result (ARR by construction). arrLen: the
   * ARR length as f64 (0 for non-ARR kinds; arg borrowed). arrAt: the
   * element at index (+1; the undefined singleton past the end). Neither
   * throws. */
  "dyn.arrLen": { argTypes: [DYN], result: F64 },
  "dyn.arrAt": { argTypes: [DYN, F64], result: DYN },
  /** `key in v` with a RUNTIME (string) key on a checked-dynamic
   * receiver (args: value dyn, key string; result bool): OBJ answers
   * own-member presence, ARR answers 'length'/a valid index — exactly
   * the literal-key dynHasKey path. Proxy has traps may throw. */
  "dyn.hasKey": { argTypes: [DYN, STRING], result: BOOL },
  /** The `in` operator with a runtime string key: dyn.hasKey plus the
   * members inherited from builtin and compiled class prototypes. */
  "dyn.in": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.freeze": { argTypes: [DYN], result: DYN },
  "dyn.isFrozen": { argTypes: [DYN], result: BOOL },
  "dyn.nativeSetNew": { argTypes: [DYN], result: DYN },
  "dyn.collectionConstruct": { argTypes: [STRING, DYN], result: DYN },
  "dyn.setValues": { argTypes: [DYN], result: DYN },
  "dyn.nativeSetIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeMapIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeUrlIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeSearchParamsIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeDateIs": { argTypes: [DYN], result: BOOL },
  "dyn.nativeDateHandleIs": { argTypes: [DYN], result: BOOL },
  /** A builtin constructor (`Object`, `Date`, `RegExp`, `Map`, `Set`,
   * `Promise`, `WeakMap`, `WeakSet`) read as a JavaScript value: one
   * interned function per name, the same one dynamic values answer for
   * `.constructor`. The name is a compiler-chosen literal. */
  "dyn.globalConstructor": { argTypes: [STRING], result: DYN },
  /* A module class value (`http.IncomingMessage`, `http2.Http2ServerRequest`):
   * the module and class names plus the class's arity. */
  "dyn.moduleClassValue": { argTypes: [STRING, STRING, F64], result: DYN },
  /** A builtin global function (setTimeout, setInterval, setImmediate,
   * the clear functions, queueMicrotask, process.nextTick) read as a
   * JavaScript value: one interned function per name whose calls run the
   * timer APIs (it pulls in the event loop). The name is a compiler-chosen
   * literal. */
  "dyn.builtinFunction": { argTypes: [STRING], result: DYN },
  "dyn.namespaceNew": { argTypes: [STRING, DYN], result: DYN },
  "dyn.namespaceDefine": { argTypes: [DYN, STRING, DYN, F64, F64], result: VOID },
  "dyn.nativeRegexIs": { argTypes: [DYN], result: BOOL },
  /** toString() on a checked-dynamic receiver: runtime kind dispatch
   * (bytes decode per the literal encoding — utf8 default; strings,
   * numbers, booleans, arrays, objects answer JS-exactly; undefined and
   * null throw the catchable TypeError). */
  "dyn.toString": { argTypes: [DYN, DYN, STRING], result: STRING },
  "dyn.valueOf": { argTypes: [DYN, STRING], result: DYN },
  /** Object.defineProperties over dyn values (args: target, descriptors —
   * both borrowed dyn; result: the target, +1 — JS's return value).
   * Value descriptors become own properties on OBJ and FUNC targets;
   * OBJ targets preserve data attributes. get/set
   * descriptors and non-object targets/descriptors throw catchably
   * (Node's TypeError texts; accessors the "not supported yet" Error). In
   * the may-throw seed set. */
  "dyn.defineProps": { argTypes: [DYN, DYN], result: DYN },
  "dyn.defineProperty": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** dyn.defineProps / dyn.defineProperty / dyn.objCreateWithProperties
   * for a descriptor (or a property-descriptor map) built by an expression
   * instead of a plain object literal: ToPropertyDescriptor accepts any
   * object and reads each field through [[HasProperty]] and [[Get]]. */
  "dyn.definePropsShapes": { argTypes: [DYN, DYN], result: DYN },
  "dyn.definePropertyShapes": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.objCreateWithPropertiesShapes": { argTypes: [DYN, DYN], result: DYN },
  "dyn.getOwnPropertyDescriptor": { argTypes: [DYN, DYN], result: DYN },
  "dyn.arrayProtoCall": { argTypes: [DYN, STRING, DYN], result: DYN },
  /** The same call through the array-like unit (JavaScript sources):
   * Array.prototype's generic algorithms over a receiver that is not a
   * native array, and the invoke unit's dispatch for everything else. */
  "dyn.arrayLikeProtoCall": { argTypes: [DYN, STRING, DYN], result: DYN },
  /** Number.prototype / Boolean.prototype as JavaScript values: the
   * wrapper unit's prototype object, which is also the compiled
   * constructor's `prototype` member (one object per kind). */
  "dyn.builtinPrototype": { argTypes: [STRING, DYN], result: DYN },
  /** Promise.all / Promise.allSettled / Promise.any over a spread
   * checked-dynamic array: the values, the settled-record array, or the
   * first fulfillment (AggregateError once every entry rejects).
   * Thenable elements adopt; the second argument reads a program class
   * instance's `then` (the compiled property dispatch). */
  "dyn.promiseAll": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "dyn.promiseAllSettled": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  "dyn.promiseAny": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  /** PromiseResolve over one checked-dynamic value: the promise it holds,
   * a promise that adopts a thenable's settlement, or a promise fulfilled
   * with the value. The second argument reads `then` as above. */
  "dyn.promiseResolve": { argTypes: [DYN, DYN], result: { kind: "promise", inner: DYN } },
  /** Bare `typeof v` on a dyn value AS A STRING (arg: the dyn value,
   * borrowed; result: an owned string) — the dyn kind's JS answer:
   * undefined→"undefined", null/object/array/bytes→"object" (JS's oldest
   * wart preserved), boolean/number/string by kind, function→"function".
   * Never throws. */
  "dyn.typeof": { argTypes: [DYN], result: STRING },
  /** Object.prototype.toString.call on a checked-dynamic value. */
  "dyn.objectTag": { argTypes: [DYN], result: STRING },
  // Builtin functions read as values: validateString under Node's argument
  // name, and node:path's value adapters (scr_builtin_values.c).
  "dyn.validateString": { argTypes: [DYN, STRING], result: STRING },
  "dyn.validateStrings": { argTypes: [DYN, STRING], result: arrayOf(STRING) },
  /** getValidatedPath over an untyped path of a synchronous fs function
   * (JavaScript sources): [value, Node's parameter name, whether Node
   * first asks for a file descriptor]. A string, a URL or a Uint8Array
   * answers its path; anything else throws Node's ERR_INVALID_ARG_TYPE.
   * In a descriptor position the value first converts to a number, as
   * Node's test does, and a number throws the named refusal. May-throw.
   * Named in the dyn family, not fs: it converts an argument and reads
   * no file system state, so it is not an ambient operation (the fs call
   * that takes the path is). */
  "dyn.validateFsPath": { argTypes: [DYN, STRING, BOOL], result: STRING },
  /** markAsUncloneable(value) (scr_json.c; the value borrowed). */
  "dyn.markUncloneable": { argTypes: [DYN], result: VOID },
  "dyn.this": { argTypes: [], result: DYN },
  "dyn.generatorThis": { argTypes: [], result: DYN },
  /** JS ToString over a dyn value WITH the object protocol (a user
   * toString/valueOf member is CALLED and its throw propagates;
   * exhaustion throws "Cannot convert object to primitive value"; units
   * render "null"/"undefined") — the WHATWG USVString conversions
   * (URLSearchParams names/values). Borrowed dyn; +1 string. May-throw. */
  "dyn.toStringCoerce": { argTypes: [DYN], result: STRING },
  "dyn.stringConstructor": { argTypes: [DYN], result: STRING },
  /** Registers a class's compiled String(instance) (the conversion method
   * its instances run) under the class's instance-capsule type key, for
   * the untyped conversion. */
  "dyn.registerClassToString": { argTypes: [STRING, DYN], result: VOID },
  "dyn.propertyKey": { argTypes: [DYN], result: DYN },
  "dyn.toNumeric": { argTypes: [DYN], result: DYN },
  "dyn.increment": { argTypes: [DYN, BOOL], result: DYN },
  /** Unary minus: ToNumeric, then the negation of that number or BigInt. */
  "dyn.negate": { argTypes: [DYN], result: DYN },
  /** JS ToNumber over a dyn value WITH the object protocol (number-hint
   * valueOf/toString ordering; user throws propagate). Borrowed dyn;
   * f64 result, or a throw. Used by statically lowered numeric coercions
   * whose checker type remained any. */
  "dyn.numberConstructor": { argTypes: [DYN], result: F64 },
  "dyn.bigintConstructor": { argTypes: [DYN], result: BIGINT_T },
  "dyn.toNumberCoerce": { argTypes: [DYN], result: F64 },
  "dyn.add": { argTypes: [DYN, DYN], result: DYN },
  "dyn.arithmetic": { argTypes: [DYN, DYN, STRING], result: DYN },
  "dyn.compare": { argTypes: [DYN, DYN, STRING], result: BOOL },
  "dyn.bitwise": { argTypes: [DYN, DYN, STRING], result: DYN },
  "dyn.proxyNew": { argTypes: [DYN, DYN], result: DYN },
  /** `key in globalThis`: the host-global check, then the global object's
   * presence answer: the program's own global properties, then the names
   * Node's global object has (lower-global-value.ts
   * globalObjectPresentNamesArg; scr_global_host_absent.c). */
  "dyn.globalHas": { argTypes: [STRING, arrayOf(STRING)], result: BOOL },
  /** Installs the program's static-member lookup for builtin constructor
   * values (builtin-statics.ts). */
  "dyn.installBuiltinStatics": { argTypes: [DYN], result: VOID },
  /** SameValue over checked values, including NaN, signed zero and reference identity. */
  "dyn.sameValue": { argTypes: [DYN, DYN], result: BOOL },
  /** `d instanceof TypeError` (and the other BUILTIN error classes) on a
   * checked-dynamic value (scr_json.c): the from_error cache holds the
   * dyn↔error identity edge, so the test resolves the runtime error and
   * asks its vtable's stamped preorder interval — exact for every error
   * that crossed the boundary. A dyn object that never came from an
   * error (a hand-built {%error} literal) answers false: subclass
   * identity is unknowable there (the root keeps dynTest's marker
   * answer). args are the borrowed dyn and the SCR_ERR_* kind literal.
   * Never throws. */
  "dyn.errInstanceof": { argTypes: [DYN, F64], result: BOOL },
  "dyn.fromEntries": { argTypes: [DYN], result: DYN },
  /** The ambient receiver — JS `this` in a plain (non-method) function
   * body: the innermost binding the current firing/dispatch window
   * pushed (Node's listener receiver, a dyn OBJ method's object, an
   * apply/call thisArg), or the undefined dyn singleton with none bound
   * (the strict-mode plain-call answer, the old constant). Zero args →
   * dyn (+1). Never throws. */
  "dyn.dataViewIs": { argTypes: [DYN], result: BOOL },
  "dyn.construct": { argTypes: [DYN, DYN, STRING], result: DYN },
  /** Object.keys/values/entries over a CHECKED-DYNAMIC receiver
   * (scr_json.c): the runtime walks the dyn node's own members in JS
   * own-key order (array-index keys ascending first, then insertion
   * order) and answers a dyn array (entries: an array of [key, value]
   * pairs; values RETAIN the member nodes — reference semantics, like
   * JS). Strings/arrays/bytes answer their index keys; other scalars an
   * empty array; null/undefined throw Node's catchable TypeError
   * ("Cannot convert undefined or null to object"). */
  "dyn.objKeys": { argTypes: [DYN], result: DYN },
  "dyn.forInKeys": { argTypes: [DYN], result: DYN },
  "dyn.forInKeyStrings": { argTypes: [DYN], result: arrayOf(STRING) },
  "dyn.forInStable": { argTypes: [DYN], result: BOOL },
  "dyn.objKeyStrings": { argTypes: [DYN], result: arrayOf(STRING) },
  /** Object.entries as a native [string, any][] (VOID: the tuple row's
   * shape is program-dependent; the validator checks it). */
  "dyn.objEntryPairs": { argTypes: [DYN], result: VOID },
  "dyn.hasOwn": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.propertyIsEnumerable": { argTypes: [DYN, STRING], result: BOOL },
  /** Object.prototype.isPrototypeOf(receiver, value) over checked-dynamic
   * operands: ToObject throws on a nullish receiver, and the argument's
   * prototype chain is walked comparing each link with the receiver by
   * identity. */
  "dyn.isPrototypeOf": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.assign": { argTypes: [DYN, DYN], result: DYN },
  "dyn.copyDataProperties": { argTypes: [DYN, DYN], result: DYN },
  "dyn.objectRest": { argTypes: [DYN, DYN], result: DYN },
  /** Variadic Object.assign over CHECKED-DYNAMIC targets (`Object.assign(
   * {}, ...arr.map(f), tail)` — the option-table merge): the lowering
   * builds one fresh dyn pack of sources (packPush retains a plain source
   * in; packPushSpread flattens a spread source through the spread-call
   * walk — V8's exact TypeError texts, the string arg spelling the spread
   * expression for the nullish form), so every source evaluates and
   * flattens BEFORE any copying (JS's ArgumentListEvaluation), then
   * assignAll copies each pack element's own enumerable keys onto the
   * target left to right and answers the TARGET (+1) — identity, like JS.
   * assignAll throws Node's ToObject TypeError on a nullish target. */
  "dyn.packPush": { argTypes: [DYN, DYN], result: VOID },
  "dyn.packPushSpread": { argTypes: [DYN, DYN, STRING], result: VOID },
  /** The iterated-path spread twin: V8 spells the optimized apply-path
   * texts (packPushSpread's — the expression named for nullish sources)
   * only for the SINGLE LAST argument's spread; any other spread position
   * drives the real iterator protocol, whose failure describes the VALUE
   * ("object null is not iterable (cannot read property
   * Symbol(Symbol.iterator))"). The frontend picks by position. */
  "dyn.packPushSpreadIter": { argTypes: [DYN, DYN], result: VOID },
  "dyn.reflectApply": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** Reflect.construct(target, argumentsList[, newTarget]): constructs
   * `target` with the list's elements, using `newTarget`'s prototype when
   * the third ARGUMENT is present (an explicit undefined is Node's
   * IsConstructor TypeError, not the absent case, so the trailing bool is
   * the call's arity). A distinct newTarget over an ordinary function runs
   * the target over a receiver built from newTarget's prototype; the forms
   * the runtime cannot build honestly (a class or builtin target with a
   * distinct newTarget) throw the "not supported yet" Error rather than
   * diverge. May throw Node's TypeErrors. */
  "dyn.reflectConstruct": { argTypes: [DYN, DYN, DYN, BOOL], result: DYN },
  "dyn.reflectGet": { argTypes: [DYN, DYN, DYN], result: DYN },
  /** `using` / `await using` with a dyn value (scr_json.c): usingMethod
   * runs the declaration's checks and answers what usingDispose calls at
   * scope exit (undefined for a null or undefined value). The bool selects
   * `await using`. Both throw Node's TypeErrors or the method's error. */
  "dyn.usingMethod": { argTypes: [DYN, BOOL], result: DYN },
  "dyn.usingDispose": { argTypes: [DYN, DYN], result: DYN },
  "dyn.reflectSet": { argTypes: [DYN, DYN, DYN, DYN], result: BOOL },
  "dyn.reflectDefine": { argTypes: [DYN, DYN, DYN], result: BOOL },
  "dyn.abstractEq": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.assignAll": { argTypes: [DYN, DYN], result: DYN },

  "dyn.objCreateNullProto": { argTypes: [], result: DYN },
  "dyn.arrayPrototype": { argTypes: [], result: DYN },
  "dyn.arrayConstructor": { argTypes: [], result: DYN },
  "dyn.objectPrototype": { argTypes: [], result: DYN },
  /** Function.prototype as a value: an anonymous function answering
   * undefined, length 0 and name "", one value per program. */
  "dyn.functionPrototype": { argTypes: [], result: DYN },
  "dyn.errorPrototype": { argTypes: [], result: DYN },
  "dyn.inheritsErrorPrototype": { argTypes: [DYN], result: BOOL },
  "dyn.errorCaptureStackTraceFunction": { argTypes: [], result: DYN },
  "dyn.functionApply": { argTypes: [], result: DYN },
  "dyn.builtinMethod": { argTypes: [STRING, STRING], result: DYN },
  /** A <Class>.prototype member value (scr_dyn_collections.c) for Set,
   * Map, WeakMap or WeakSet: one interned function per (class, name), so
   * `Map.prototype.get.call(receiver, key)` brand-checks and runs the
   * member's implementation. */
  "dyn.collectionMethod": { argTypes: [STRING, STRING], result: DYN },
  /** %<Class>.prototype%, the object `Object.getPrototypeOf(new Map())`
   * answers. */
  "dyn.collectionPrototype": { argTypes: [STRING], result: DYN },
  /** Object.getPrototypeOf for a value that may be a collection handle. */
  "dyn.collectionGetPrototype": { argTypes: [DYN], result: DYN },
  /** The ES2025 Set compositions over a set-like argument. */
  "dyn.setCombine": { argTypes: [DYN, STRING, DYN], result: DYN },
  /** <Class>.prototype.forEach with a callback that is not statically a
   * function: Node's `<value> is not a function` for a non-callable, and
   * (value, value, set) / (value, key, map) visits otherwise. */
  "dyn.collectionForEach": { argTypes: [DYN, STRING, DYN, DYN], result: VOID },
  /** A builtin prototype method as a function value, by its prototype
   * (`String`, `RegExp`) and canonical member name (`trim`, `trimStart`,
   * `trimEnd`; `exec`, `test`, `toString`): the unit in
   * scr_dyn_builtin_methods.c. */
  "dyn.builtinMethodValue": { argTypes: [STRING, STRING], result: DYN },
  /** A standard library prototype object as a value (`Date.prototype` read
   * in a JavaScript source), named by its constructor: the unit in
   * scr_dyn_stdlib_prototype.c. */
  "dyn.stdlibPrototype": { argTypes: [STRING], result: DYN },
  /** DataView.prototype as a value (`DataView.prototype` read in a
   * JavaScript source): the getter/setter family's prototype object, the
   * unit in scr_data_view_proto.c. */
  "dyn.dataViewPrototype": { argTypes: [DYN], result: DYN },
  "dyn.classPrototype": { argTypes: [DYN, DYN], result: DYN },
  "dyn.classBasePrototype": { argTypes: [DYN], result: DYN },
  "dyn.classInherit": { argTypes: [DYN, DYN], result: DYN },
  /** EventEmitter (0), Stream (1), Readable (2), Writable (3), Duplex (4),
   * Transform (5) and PassThrough (6) as untyped constructor values, one
   * per thread (scr_dyn_builtin_class.c). */
  "dyn.builtinClass": { argTypes: [F64], result: DYN },
  /** The stream classes (2-6 above) with their stream half: constructor
   * functions over them get native stream state
   * (scr_dyn_builtin_stream.c). */
  "dyn.builtinStreamClass": { argTypes: [F64], result: DYN },
  /** `value instanceof C` for those constructors, over the value's
   * prototype chain. */
  "dyn.builtinInstanceOf": { argTypes: [DYN, F64], result: BOOL },
  /** `value instanceof f` for an untyped constructor function: the
   * prototype chain against f.prototype. */
  "dyn.functionInstanceOf": { argTypes: [DYN, DYN], result: BOOL },
  "dyn.classSuper": { argTypes: [DYN, DYN, DYN], result: VOID },
  "dyn.assignPrototype": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.definePrototypeProps": { argTypes: [DYN, DYN, DYN], result: DYN },
  "dyn.bagGet": { argTypes: [DYN, STRING, DYN], result: DYN },
  /** A class field's creation in its instance's property bag: adds the
   * string key as a default data property when absent, answering false
   * (nothing changed) when the bag needs the general defineProperty path. */
  "dyn.bagCreateField": { argTypes: [DYN, STRING], result: BOOL },
  "dyn.bagSet": { argTypes: [DYN, STRING, DYN, DYN], result: VOID },
  "dyn.objCreate": { argTypes: [DYN], result: DYN },
  // Names a compiled class's prototype object (args[0]) after the class
  // (args[1]) for util.inspect.
  "dyn.nameClassPrototype": { argTypes: [DYN, STRING], result: VOID },
  "dyn.objCreateWithProperties": { argTypes: [DYN, DYN], result: DYN },
  "dyn.getPrototype": { argTypes: [DYN], result: DYN },
  // dyn.getPrototype for walks that compare each prototype with a program
  // class's prototype: it answers for every value, and a value no program
  // class's prototype can be on the chain of ends the walk (null).
  "dyn.classTestPrototype": { argTypes: [DYN], result: DYN },
  "dyn.setPrototype": { argTypes: [DYN, DYN], result: DYN },
  "dyn.getOwnPropertyNames": { argTypes: [DYN], result: DYN },
  "dyn.ownKeys": { argTypes: [DYN], result: DYN },
  "dyn.getOwnPropertySymbols": { argTypes: [DYN], result: DYN },
  "dyn.getOwnPropertyDescriptors": { argTypes: [DYN], result: DYN },
  "dyn.preventExtensions": { argTypes: [DYN], result: DYN },
  "dyn.isExtensible": { argTypes: [DYN], result: BOOL },
  "dyn.seal": { argTypes: [DYN], result: DYN },
  "dyn.isSealed": { argTypes: [DYN], result: BOOL },
  /** Object.isExtensible / Object.isSealed of a value whose kind is known
   * only at runtime: a native handle or a promise has no modeled integrity
   * state, so these refuse (SC2020) instead of answering like
   * dyn.isExtensible/dyn.isSealed, which the static arms (a class
   * instance's checked view, a typed function value) keep using. */
  "dyn.isExtensibleQuery": { argTypes: [DYN], result: BOOL },
  "dyn.isSealedQuery": { argTypes: [DYN], result: BOOL },
  "dyn.objValues": { argTypes: [DYN], result: DYN },
  /** Object.values as a native vector of checked values, for results the
   * program consumes directly (for-of, index reads, read-only methods). */
  "dyn.objValueList": { argTypes: [DYN], result: arrayOf(DYN) },
  "dyn.objEntries": { argTypes: [DYN], result: DYN },
  /** structuredClone over the checked-dynamic tree (scr_json.c): the JSON-safe subset plus
   * bytes (a fresh copy — a Buffer clones as a plain Uint8Array, like
   * Node), deep. Functions and handle kinds throw the spec's catchable
   * DataCloneError; CYCLES throw the scriptc fence (the checked-dynamic tree cannot
   * represent them — Node clones cycles; documented divergence). The
   * options dyn value validates with Node's exact errors (dictionary
   * conversion, the transfer-sequence member; any non-empty transfer
   * list throws DataCloneError). dyn.cloneMissing is the zero-argument
   * call: always throws Node's TypeError [ERR_MISSING_ARGS] with Node's
   * own (verbatim, doubly-wrapped) message. */
  "dyn.structuredClone": { argTypes: [DYN, DYN], result: DYN },
  "dyn.truthy": { argTypes: [DYN], result: BOOL },
  /** The declaration-typed boundary's adoption (decl-projection.ts):
   * `source` is the dynamic value a boundary cast just converted, and
   * `capsule` a live capsule of the native value built from it. Every
   * object or array of `source` that something else still references
   * becomes, in place, a live capsule of the native value built from it.
   * Throws the path TypeError, changing nothing, when a converted object
   * is not plain data (a prototype, accessors, symbols, frozen state). */
  "dyn.declAdopt": { argTypes: [DYN, DYN], result: VOID },
  /** dyn.declAdopt for every other checked cast of a dynamic value to a
   * record or array (`value as T`): a shared source object or array
   * becomes a live capsule of the value built from it. A node that is not
   * plain data, or that the value holds twice, keeps its separate copy.
   * Never throws: the conversion already succeeded. */
  "dyn.adoptShared": { argTypes: [DYN, DYN], result: VOID },
  /** Whether adoption has anything to do for `source`: it is a plain
   * object or array. A capsule of a native value, a primitive and every
   * other value are left alone, so a cast asks this before it boxes its
   * result for the adoption call. */
  "dyn.adoptable": { argTypes: [DYN], result: BOOL },
  "dyn.cloneMissing": { argTypes: [], result: DYN },
  /** structuredClone with a NON-EMPTY transfer array of static values:
   * nothing static is transferable, so the call always throws Node's
   * catchable DataCloneError ("Found invalid value in transferList.") —
   * lowered directly (the list's values need no dyn representation to
   * fail). */
  "dyn.cloneTransferFail": { argTypes: [], result: DYN },
  /** The same refusal given the transfer list's first member, an
   * ArrayBuffer: a Buffer pool slab gets Node's untransferable message. */
  "dyn.cloneTransferFailWith": { argTypes: [DYN], result: DYN },
  "dyn.isPlainObject": { argTypes: [DYN], result: BOOL },
});
