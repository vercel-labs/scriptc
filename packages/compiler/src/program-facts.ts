/* The registry of whole-program facts.
 *
 * A whole-program fact is a decision that one occurrence somewhere in a
 * program makes for code that has nothing to do with the occurrence: every
 * value of a type, every site of a kind, a whole file, a whole shape, or the
 * runtime build the program links. Such a fact is a cliff: an unrelated line
 * changes how other code compiles. Some are sound closed-world choices, some
 * are designed, and some are shortcuts; all of them are listed here, so that
 * adding one is a visible act and removing one has a list to work from.
 *
 * Nothing in the compiler reads this module. program-facts.test.ts holds
 * the registry to the source:
 *
 *  - every `file` contains its `symbol`;
 *  - no fact is derived from source text or from a spelling, except the
 *    ones the test names while they are being removed;
 *  - every place the compiler iterates the program's source files, or tests
 *    a source file's raw text, is a PROGRAM_SCANS row, either as the scan
 *    that decides a registered fact or with the reason it decides none;
 *  - every `lowererFields` name is one Lowerer.unjournaled lists.
 *
 * To add a whole-program fact: prefer the fact about the value, the site or
 * the symbol it concerns. If the fact has to be program-wide, derive it from
 * the syntax tree, symbols, types or IR, register it here, and say what it
 * would take to make it narrower. */

/** What a fact is derived from. `text` (a file's raw characters, comments
 * and strings included) and `spelling` (any identifier of a given name,
 * whatever it refers to) decide nothing about the program's meaning; the
 * test allows no new fact of either kind. */
export type ProgramFactSource =
  | "syntax"
  | "symbols"
  | "types"
  | "ir"
  | "option"
  | "text"
  | "spelling";

/** How far one occurrence reaches. */
export type ProgramFactScope = "program" | "file" | "type" | "shape" | "runtime-build";

export interface ProgramFact {
  /** The name the fact is referred to by. */
  readonly name: string;
  /** The file that decides it, from the repository root. */
  readonly file: string;
  /** An identifier in that file that decides or holds it. */
  readonly symbol: string;
  readonly source: ProgramFactSource;
  readonly scope: ProgramFactScope;
  /** The occurrence that sets it. */
  readonly setBy: string;
  /** What it switches once set. */
  readonly gates: string;
  /** What a narrower rule would key on, or why none is wanted. */
  readonly narrower: string;
  /** The design, decision or follow-up entry that tracks it; null when
   * nothing does. */
  readonly tracked: string | null;
  /** The Lowerer fields that cache it on first use. */
  readonly lowererFields: readonly string[];
}

const SRC = "packages/compiler/src";

export const PROGRAM_FACTS: readonly ProgramFact[] = [
  {
    name: "member-call-receivers",
    file: `${SRC}/frontend/lowering/member-call-receivers.ts`,
    symbol: "memberCallReceivers",
    source: "symbols",
    scope: "program",
    setBy:
      "a store of a function that reads the receiver of its call (a function with its own `this`, outside classes) into a member, by the member's name; and, once such a function reaches a place the census does not follow, any store of a value it cannot classify",
    gates:
      "a member call on a record whose member has that name passes the record as the call's receiver, boxed only if the callee reads it",
    narrower:
      "the member's declaring symbol instead of its name, and the function values that can reach the store, by type flow",
    tracked: "pi-decisions DECISIONS.md 2026-11-07, unbound-method-this slice 2",
    lowererFields: ["memberReceivers"],
  },
  {
    name: "thenables-may-be-defined",
    file: `${SRC}/frontend/lowering/thenables.ts`,
    symbol: "programMayDefineThenables",
    source: "text",
    scope: "program",
    setBy:
      "a regular expression over each file's raw text that looks for a `then` definition; it matches in comments and strings",
    gates:
      "every `await` of a checked-dynamic value: PromiseResolve and adoption instead of the plain dynamic await",
    narrower: "the awaited value, at run time",
    tracked: null,
    lowererFields: ["thenablesMayBeDefined"],
  },
  {
    name: "creates-wrappers",
    file: `${SRC}/frontend/lowering/primitive-wrappers.ts`,
    symbol: "programCreatesWrappers",
    source: "symbols",
    scope: "program",
    setBy: "a `new String/Number/Boolean` or an `Object(value)` call in a JavaScript source",
    gates:
      "the mapping of the boxed interface types (`String`, `Number`, `Boolean`) to the checked-dynamic value",
    narrower: "a per-value wrapper tag; closed-world today",
    tracked: "designs/t262-primitive-wrappers",
    lowererFields: ["createsWrappers"],
  },
  {
    name: "typed-web-streams",
    file: `${SRC}/frontend/lowering/builtins/web-streams-dyn.ts`,
    symbol: "programUsesTypedWebStreams",
    source: "symbols",
    scope: "program",
    setBy:
      "a `tee`, `pipeTo` or `pipeThrough` call, a `new WritableStream`, or a `new TransformStream` with arguments in a TypeScript source",
    gates:
      "every ReadableStream, WritableStream and TransformStream value is built with the web stream classes, and two runtime twins",
    narrower: "the construction site of the stream",
    tracked: null,
    lowererFields: ["typedWebStreams"],
  },
  {
    name: "names-web-stream-class",
    file: `${SRC}/frontend/lowering/builtins/web-streams-dyn.ts`,
    symbol: "programNamesWebStreamClass",
    source: "symbols",
    scope: "program",
    setBy: "a reference to a web stream class in a JavaScript source",
    gates: "computed reads of the global object answer the web stream classes, which links them",
    narrower: "the name read",
    tracked: null,
    lowererFields: ["namesWebStreamClass"],
  },
  {
    name: "reads-node-object-value",
    file: `${SRC}/frontend/lowering/node-value-reads.ts`,
    symbol: "programReadsGlobalValue",
    source: "symbols",
    scope: "program",
    setBy: "a read of `process` or `performance` as a value in a JavaScript source",
    gates:
      "computed reads of the global object answer the object the value read answers, which the program then carries",
    narrower: "the name read",
    tracked: null,
    lowererFields: ["nodeObjectValueReads"],
  },
  {
    name: "web-stream-only-members",
    file: `${SRC}/frontend/lowering/builtins/web-streams-dyn.ts`,
    symbol: "programUsesWebStreamOnlyMembers",
    source: "types",
    scope: "program",
    setBy:
      "a JavaScript use of a ReadableStream member the fetch unit's stream lacks, or of such a member name on an untyped receiver in a program that links fetch",
    gates:
      "%main installs the web stream classes, so every fetch body stands for a web ReadableStream",
    narrower: "the stream value the member is read from",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "declares-array-class",
    file: `${SRC}/frontend/lowering/builtins/array-classes.ts`,
    symbol: "programDeclaresArrayClass",
    source: "symbols",
    scope: "program",
    setBy: "a class that extends Array",
    gates: "every species-creating Array method consults the receiver's species",
    narrower: "the receiver's static type",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "declares-date-class",
    file: `${SRC}/frontend/lowering/builtins/date-classes.ts`,
    symbol: "programDeclaresDateClass",
    source: "symbols",
    scope: "program",
    setBy: "a class that extends Date",
    gates: "Date methods and the dynamic dispatch table account for subclass instances",
    narrower: "the receiver's static type",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "names-temporal",
    file: `${SRC}/frontend/program.ts`,
    symbol: "programNamesTemporal7",
    source: "text",
    scope: "program",
    setBy: "the word `Temporal` anywhere in an implementation file's text, comments included",
    gates:
      "the ESNext temporal lib slice in the checker's library set, and one more program creation",
    narrower:
      "a library set is program-wide; the fact can be a reference to the global, decided from syntax and scopes",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "socket-encoding-reachable",
    file: `${SRC}/frontend/lowering/lower-server.ts`,
    symbol: "socketEncodingReachable",
    source: "types",
    scope: "program",
    setBy: "a `setEncoding` call whose receiver is a socket or an untyped value",
    gates: "the chunk type of every socket's `data` event",
    narrower: "the socket, at run time",
    tracked: null,
    lowererFields: ["socketEncodingReachable"],
  },
  {
    name: "unix-listen-reachable",
    file: `${SRC}/frontend/lowering/lower-server.ts`,
    symbol: "unixListenReachable",
    source: "types",
    scope: "program",
    setBy: "a `.listen(path)` call with a string argument on a server or an untyped value",
    gates: "every `server.address()` checks for a socket path",
    narrower: "the server",
    tracked: null,
    lowererFields: ["unixListenReachable"],
  },
  {
    name: "patches-stdio",
    file: `${SRC}/frontend/lowering/builtins/process.ts`,
    symbol: "programPatchesStdio",
    source: "symbols",
    scope: "program",
    setBy: "an assignment to `process.stdout.write` or `process.stderr.write`",
    gates:
      "every typed stdout and stderr write goes through the patchable path, and a runtime twin",
    narrower: "none wanted: a closed-world fact about two host members",
    tracked: "designs/host-patching",
    lowererFields: ["patchesStdio"],
  },
  {
    name: "reads-exit-code",
    file: `${SRC}/frontend/lowering/builtins/process.ts`,
    symbol: "programReadsExitCode",
    source: "symbols",
    scope: "program",
    setBy: "a read of `process.exitCode`",
    gates: "every write of `process.exitCode` keeps the written value for the read",
    narrower: "always track; the write is cheap",
    tracked: null,
    lowererFields: ["readsExitCode"],
  },
  {
    name: "child-additions",
    file: `${SRC}/frontend/lowering/handle-properties.ts`,
    symbol: "childAdditions",
    source: "types",
    scope: "program",
    setBy:
      "a JavaScript write or defineProperty onto a child process value, in a program whose JavaScript mentions `child_process`",
    gates:
      "reads of the written member names on every child go through the child's property box; all members when a key is computed",
    narrower: "already per member name; per child value at run time",
    tracked: "designs/handle-expandos",
    lowererFields: [],
  },
  {
    name: "handle-additions",
    file: `${SRC}/frontend/lowering/handle-properties.ts`,
    symbol: "handleAdditions",
    source: "types",
    scope: "program",
    setBy:
      "a JavaScript write, delete, definition or integrity call on a typed handle (a stream, a socket, a Map and the like)",
    gates:
      "typed handle receivers of the granted classes are boxed into their checked-dynamic value",
    narrower: "per handle class already; per value needs a table on the handle",
    tracked: "designs/handle-expandos",
    lowererFields: [],
  },
  {
    name: "replaceable-methods",
    file: `${SRC}/frontend/lowering/class-method-mutations.ts`,
    symbol: "collectClassMethodMutations",
    source: "types",
    scope: "program",
    setBy:
      "a write, delete or reflective definition whose key the compiler cannot name, through a receiver whose type does not bound the objects it can hold",
    gates:
      "every call of a class method first tests that its receiver has no own dynamic property and that no prototype object of its class family exists, and otherwise reads the method from the receiver's property table",
    narrower:
      "the receiver's class, for a typed receiver; an untyped receiver reaches every class whose instances are boxed, so what is left is the test on the instance at run time",
    tracked: "FOLLOWUPS 2026-11-07 (method-mutation-scope)",
    lowererFields: [],
  },
  {
    name: "member-assigned",
    file: `${SRC}/frontend/lowering/lower-classes.ts`,
    symbol: "memberAssigned",
    source: "syntax",
    scope: "program",
    setBy:
      "an assignment, delete or reflective definition of a member with a method's name, on any receiver",
    gates: "the static answer for that method of every class that declares the name",
    narrower: "the receiver's class",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "builtin-member-native-readers",
    file: `${SRC}/frontend/lowering/builtin-member-readers.ts`,
    symbol: "refuseUnseenBuiltinMemberWrites",
    source: "types",
    scope: "program",
    setBy:
      "a use of a built-in member that does not read it from its object (a native call, a conversion, an iteration, a decided feature test), anywhere in a program that also writes that member",
    gates:
      "the write is refused at its own site (SC1092); a program without such a use keeps the write's lowering",
    narrower:
      "the reader: a mark on the member that only its native readers test at run time, which every typed call of the member would pay for",
    tracked: "pi-decisions 2026-11-07 (replacing a built-in member)",
    lowererFields: [],
  },
  {
    name: "node-stream-modes",
    file: `${SRC}/frontend/lowering/lowerer.ts`,
    symbol: "requiresGeneralNodeStreams",
    source: "types",
    scope: "program",
    setBy: "one stream flow the typed stream representation cannot hold",
    gates: "the type of every stream slot, and a second lowering of the whole program",
    narrower: "no cheap rule: designs/single-pass-lowering",
    tracked: "pi-build-speed PLAN-2 D16",
    lowererFields: [],
  },
  {
    name: "whole-slot-degradation",
    file: `${SRC}/frontend/lowering/lowerer.ts`,
    symbol: "wholeSlotDegradation",
    source: "types",
    scope: "program",
    setBy: "a first lowering that ends with partially degraded slot types",
    gates: "a second lowering of the whole program with those slots checked-dynamic",
    narrower: "the slot, once slots are decided before bodies lower",
    tracked: "pi-build-speed PLAN-2 D17",
    lowererFields: [],
  },
  {
    name: "degraded-types",
    file: `${SRC}/frontend/lowering/lowerer.ts`,
    symbol: "degradedTypes",
    source: "types",
    scope: "type",
    setBy:
      "one slot whose type has no layout and whose unit is about to fail the build (localized failure's commit point): a generic call instantiated at `any[]`, for example",
    gates:
      "every later mapping of that checker type anywhere in the program takes the degraded layout (`any[]` becomes an array of checked-dynamic elements) where it had none, so sites that chose their own storage for the type now convert to that layout",
    narrower: "the slot that failed, once slot layouts are decided before bodies lower",
    tracked: "FOLLOWUPS 2026-11-07 (pi-fences-typebox); pi-build-speed PLAN-2 D17",
    lowererFields: [],
  },
  {
    name: "async-protocol-holders",
    file: `${SRC}/frontend/lowering/async-protocol-holders.ts`,
    symbol: "AsyncProtocolHolders",
    source: "types",
    scope: "type",
    setBy:
      "a value that is not a compiled async generator flowing into an AsyncIterable, AsyncIterableIterator or AsyncIterator slot, or a Node island's declarations naming one of the three",
    gates:
      "every slot of the three interfaces over that element type holds the checked-dynamic value",
    narrower: "the slot, once type mapping knows the declaration it serves",
    tracked: "FOLLOWUPS 2026-11-03; pi-decisions 2026-11-07 island-cliffs",
    lowererFields: ["ownAsyncProtocolHolders"],
  },
  {
    name: "partial-assertion-targets",
    file: `${SRC}/frontend/lowering/partial-assertions.ts`,
    symbol: "partialTargetOf",
    source: "types",
    scope: "shape",
    setBy: "a record literal asserted to a type whose required fields it does not write",
    gates: "member reads and `in` tests of those fields on every value of the asserted shape",
    narrower: "by design: the view's absent state belongs to the shape",
    tracked: "object-model S1",
    lowererFields: [],
  },
  {
    name: "boxed-union-ids",
    file: `${SRC}/backend/llvm/nullable-unions.ts`,
    symbol: "boxedUnionIds",
    source: "ir",
    scope: "type",
    setBy: "one Map key or Set element of a union type",
    gates: "that union keeps the boxed representation everywhere",
    narrower: "the container site",
    tracked: "FOLLOWUPS 2026-11-03",
    lowererFields: [],
  },
  {
    name: "function-views",
    file: `${SRC}/frontend/lowering/function-views.ts`,
    symbol: "FunctionViews",
    source: "ir",
    scope: "type",
    setBy:
      "one signature adapter that holds a function with more parameters, a rest parameter, or another parameter type, at a function type",
    gates:
      "every conversion of that function type to one with more parameters or a wider parameter type, and every boxing of it, tests whether the value is such a view and starts from the function it forwards to",
    narrower:
      "the value, at run time: an entry on the closure that takes an argument count, which needs a closure field and dynamic arguments",
    tracked: "pi-decisions DECISIONS.md 2026-11-07 (fn-slot-widening)",
    lowererFields: [],
  },
  {
    name: "record-view-targets",
    file: `${SRC}/backend/llvm/record-views.ts`,
    symbol: "planRecordViews",
    source: "ir",
    scope: "shape",
    setBy: "one checked conversion that can produce a record shape another live record covers",
    gates: "every field access of that shape tests the view mark",
    narrower: "by design: identity through views",
    tracked: "object-model S1 D1",
    lowererFields: [],
  },
  {
    name: "width-copy-observation",
    file: `${SRC}/frontend/lowering/width-copies.ts`,
    symbol: "Observations",
    source: "ir",
    scope: "type",
    setBy:
      "one write to a field or element of a record, array or class layout, one identity comparison of its values, or one value of it that reaches untyped code or the runtime",
    gates:
      "SC6001 at every conversion that copies an aliasable value into or out of that layout, and the SC1090 refusal of an aliasable record converted to a class instance; no emitted code",
    narrower:
      "the copied value's own path: a copy nothing writes, compares or lets out, whose source is not written while it lives; conversions that keep the object need no report",
    tracked: "pi-decisions DECISIONS.md 2026-11-07 (divergence-soundness); object-model S1 D1",
    lowererFields: [],
  },
  {
    name: "key-order-variants",
    file: `${SRC}/ir/ir.ts`,
    symbol: "orderVariants",
    source: "ir",
    scope: "shape",
    setBy: "object literals of one shape that write its keys in more than one order",
    gates:
      "a hidden order field on every value of the shape, and a dispatch on each key-order surface",
    narrower: "by design: the order belongs to the value",
    tracked: "FOLLOWUPS 2026-10-29 (kept-key order)",
    lowererFields: [],
  },
  {
    name: "unwind-abi-violation",
    file: `${SRC}/backend/llvm/unwind-abi.ts`,
    symbol: "unwindAbiFunctions",
    source: "ir",
    scope: "program",
    setBy: "one function whose emitted code breaks the unwind ABI's assumption",
    gates: "the whole module is emitted again",
    narrower: "the function",
    tracked: "FOLLOWUPS 2026-11-03",
    lowererFields: [],
  },
  {
    name: "js-object-model-build",
    file: `${SRC}/ir/runtime-features.ts`,
    symbol: "jsObjectModelFact",
    source: "ir",
    scope: "runtime-build",
    setBy: "any JavaScript object-model operation in the program's IR",
    gates: "eight runtime units swap to their SCR_JS_OBJECT_MODEL twins",
    narrower: "hooks an optional unit installs, instead of twin builds",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "host-absent-globals",
    file: `${SRC}/ir/runtime-features.ts`,
    symbol: "hostAbsentGlobals",
    source: "ir",
    scope: "runtime-build",
    setBy: "one computed read of the global object, or one `in globalThis` test",
    gates: "the SCR_GLOBAL_HOST_ABSENT twin of the builtin lookup unit",
    narrower: "the read site",
    tracked: null,
    lowererFields: [],
  },
  {
    name: "mutable-buffers",
    file: `${SRC}/ir/runtime-features.ts`,
    symbol: "mutableBuffers",
    source: "ir",
    scope: "runtime-build",
    setBy: "one resizable, growable or detachable ArrayBuffer operation in a JavaScript source",
    gates: "the views registry is armed and every view's length is recomputed",
    narrower: "the buffer",
    tracked: "designs/t262-dc",
    lowererFields: [],
  },
  {
    name: "generic-call-array-holes",
    file: `${SRC}/frontend/lowering/runtime-optional-elements.ts`,
    symbol: "scanGenericCall",
    source: "types",
    scope: "type",
    setBy:
      "an array that can hold holes, reachable by a call of a generic function that builds arrays from generic ones",
    gates:
      "arrays of every element type that call can reach, and of its result, read as possibly holding a hole or undefined",
    narrower: "the element type of the callee's instance, where the instance builds the array",
    tracked: "FOLLOWUPS 2026-11-07 (holed-array-generics)",
    lowererFields: [],
  },
  {
    name: "generic-built-array-elements",
    file: `${SRC}/frontend/lowering/runtime-optional-elements.ts`,
    symbol: "elementsPresent",
    source: "types",
    scope: "program",
    setBy: "one array that can hold a hole or undefined, anywhere in the program",
    gates:
      "callbacks and index reads over an array with a concrete element type that generic code built from a generic array take the element or undefined",
    narrower:
      "the element type each instance gives the generic array, asked when the instance lowers, as the for-of decision is",
    tracked: "FOLLOWUPS 2026-11-07 (holed-array-generics)",
    lowererFields: [],
  },
  {
    name: "imports-node-api",
    file: `${SRC}/frontend/node-api-import.ts`,
    symbol: "programImportsNodeApi",
    source: "syntax",
    scope: "program",
    setBy: "an import of `@scriptc/node` in any source file of the program",
    gates:
      "clearTimeout, clearInterval and clearImmediate of a checked-dynamic handle also ask the Node island unit to clear an island's timer, and take such a handle in TypeScript; and in a build with `--define` the conditions the define decides are evaluated at run time, because code in Node.js can change the variable (constant-conditions.ts)",
    narrower:
      "the handle, at run time: a requireModule result and everything reached from it is untyped, so no site knows whether its value came from an island; for the conditions, the environment writes of the JavaScript the island runs, which the build does not read",
    tracked:
      "pi-decisions DECISIONS island-timers-iteration 2026-11-07; the integrity flag's two open edges 2026-11-09",
    lowererFields: ["importsNodeApi"],
  },
  {
    name: "computed-environment-write",
    file: `${SRC}/frontend/lowering/constant-conditions.ts`,
    symbol: "changesEnvironmentByComputedName",
    source: "symbols",
    scope: "program",
    setBy:
      "a write or `delete` of a member of `process.env`, or of a value held from it, through a name that is not a string literal, in any implementation file of a program built with `--define`",
    gates:
      "the conditions the define decides (`if` statements of TypeScript files, conditional expressions, the right operands of `&&` and `||`) are evaluated at run time in every natively lowered file",
    narrower:
      "the names the computed key can hold: a key whose type is a union of string literals that names no defined variable cannot change one",
    tracked: "pi-decisions DECISIONS.md 2026-11-09, the integrity flag rulings",
    lowererFields: ["computedEnvironmentWrite"],
  },
];

/** Why a whole-program scan decides no registered fact.
 *
 *  - `fact`: it is the scan that decides the fact named in `fact`.
 *  - `closed-world`: it answers a question about one symbol, name, class or
 *    shape, and only code that touches that one thing changes.
 *  - `prefilter`: a raw-text test that only skips a syntax walk which would
 *    find nothing, because the walk's matches have to spell the text.
 *  - `discovery`: it finds the program's modules, roots, packages or order.
 *  - `inference`: it infers a type for individual bindings.
 *  - `key`: it hashes the program for a cache or a memo. */
export type ProgramScanKind =
  | "fact"
  | "closed-world"
  | "prefilter"
  | "discovery"
  | "inference"
  | "key";

export interface ProgramScan {
  /** `<file under packages/compiler/src>#<enclosing top-level declaration>`. */
  readonly site: string;
  /** How many times the declaration iterates the program's source files or
   * tests a source file's raw text. */
  readonly count: number;
  readonly kind: ProgramScanKind;
  /** The registered fact a `fact` scan decides; null otherwise. */
  readonly fact: string | null;
  readonly why: string;
}

const scan = (
  site: string,
  count: number,
  kind: ProgramScanKind,
  why: string,
  fact: string | null = null,
): ProgramScan => ({ site, count, kind, fact, why });

const decides = (site: string, count: number, fact: string): ProgramScan =>
  scan(site, count, "fact", "", fact);

export const PROGRAM_SCANS: readonly ProgramScan[] = [
  scan(
    "frontend/contract-types.ts#collectContractAnnotations",
    2,
    "prefilter",
    "a file that never names the contract-type modules imports none of them",
  ),
  scan(
    "frontend/fork-target.ts#namesChildProcess",
    4,
    "discovery",
    "finds the modules a fork() can start, which become program roots",
  ),
  scan(
    "frontend/import-elision.ts#elideProgramImports",
    1,
    "discovery",
    "the imports and exports tsc drops, file by file: each file's answer comes from its own uses and the tsconfig above it, and decides that file's module edges",
  ),
  scan(
    "frontend/lowering/argument-counts.ts#usedAsValue",
    1,
    "closed-world",
    "whether one function is ever read as a value",
  ),
  scan(
    "frontend/lowering/assertion-members.ts#extendAssertedRecordMembers",
    1,
    "prefilter",
    "the asserted form needs an intersection with a type literal in the file",
  ),
  scan(
    "frontend/lowering/binding-analysis.ts#usedInHeritageClause",
    1,
    "closed-world",
    "whether one symbol appears in a heritage clause",
  ),
  scan(
    "frontend/lowering/binding-analysis.ts#deadUnmappableBinding",
    1,
    "closed-world",
    "whether one binding is never read",
  ),
  decides("frontend/lowering/builtins/process.ts#programReadsExitCode", 1, "reads-exit-code"),
  decides("frontend/lowering/builtins/process.ts#programPatchesStdio", 1, "patches-stdio"),
  scan(
    "frontend/lowering/builtins/process.ts#programMentionsVersions",
    2,
    "prefilter",
    "a read of a process.versions entry has to spell `versions`; the typed check behind it decides",
  ),
  decides(
    "frontend/lowering/builtins/web-streams-dyn.ts#programNamesWebStreamClass",
    1,
    "names-web-stream-class",
  ),
  decides(
    "frontend/lowering/builtins/web-streams-dyn.ts#programUsesTypedWebStreams",
    1,
    "typed-web-streams",
  ),
  decides(
    "frontend/lowering/builtins/web-streams-dyn.ts#programUsesWebStreamOnlyMembers",
    1,
    "web-stream-only-members",
  ),
  decides(
    "frontend/lowering/constant-conditions.ts#changesEnvironmentByComputedName",
    1,
    "computed-environment-write",
  ),
  scan(
    "frontend/lowering/cjs-inline-require.ts#cjsExportEvaluations",
    1,
    "closed-world",
    "where the program requires or imports one module whose export object is an accessor",
  ),
  scan(
    "frontend/lowering/cjs-inline-require.ts#computeSplitRequireBinding",
    1,
    "prefilter",
    "a split require binding's own file has to spell `require`",
  ),
  scan(
    "frontend/lowering/construction-reads.ts#classHierarchyOf",
    1,
    "prefilter",
    "a file that never spells `extends` declares no derived class",
  ),
  scan(
    "frontend/lowering/cycle-initialization.ts#earlyHeritageReference",
    1,
    "closed-world",
    "references to one class of an import cycle",
  ),
  scan(
    "frontend/lowering/cycle-initialization.ts#classLocalNames",
    1,
    "prefilter",
    "a file that never spells the class's name does not refer to it by that name",
  ),
  scan(
    "frontend/lowering/cycle-initialization.ts#classReferences",
    1,
    "closed-world",
    "references to one class of an import cycle",
  ),
  scan(
    "frontend/lowering/cycle-initialization.ts#registerCalledBindingFlag",
    1,
    "closed-world",
    "references to one storage-less binding of an import cycle: every one has to be a call",
  ),
  scan(
    "frontend/lowering/enum-objects.ts#enumObjectUsed",
    1,
    "closed-world",
    "whether one enum is ever used as a value; the text test skips files that spell none of its names",
  ),
  scan(
    "frontend/lowering/fetch-dispatcher.ts#programHasUndiciPackage",
    1,
    "closed-world",
    "whether the program contains the built-in undici package; only global fetch calls whose init can carry a dispatcher change",
  ),
  scan(
    "frontend/lowering/empty-array-places.ts#Search",
    2,
    "inference",
    "the element type of one untyped empty array literal, from the reads of its property or binding; a file that never spells the name does not read it by that name",
  ),
  scan(
    "frontend/lowering/expressions/property-access.ts#globalThisWrittenNames",
    2,
    "closed-world",
    "the names the program assigns on the global object; only reads of those names change",
  ),
  scan(
    "frontend/lowering/global-object-writes.ts#globalObjectWrites",
    2,
    "closed-world",
    "every write of the global object by any spelling; only calls and reads of a built-in through the global object change",
  ),
  decides("frontend/lowering/handle-properties.ts#childAdditions", 2, "child-additions"),
  decides("frontend/lowering/handle-properties.ts#handleAdditions", 1, "handle-additions"),
  scan(
    "frontend/lowering/handle-properties.ts#programHasJsSource",
    1,
    "prefilter",
    "only JavaScript adds properties to handles, so a program without a JavaScript file skips the census",
  ),
  scan(
    "frontend/lowering/js-collection-types.ts#inferProgram",
    1,
    "inference",
    "element types of individual untyped collections in JavaScript",
  ),
  scan(
    "frontend/lowering/json-require.ts#collectJsonRequires",
    1,
    "prefilter",
    "a require of a JSON file spells `.json`",
  ),
  decides("frontend/lowering/lower-classes.ts#memberAssigned", 2, "member-assigned"),
  scan(
    "frontend/lowering/lower-classes.ts#localSubclassesOf",
    1,
    "closed-world",
    "the subclasses of one class; the text test skips files without `extends`",
  ),
  scan(
    "frontend/lowering/lower-classes.ts#definedThroughReflection",
    1,
    "closed-world",
    "whether one class's members are defined by reflection in its own file",
  ),
  scan(
    "frontend/lowering/lower-event-emitter.ts#emitterEvents",
    1,
    "closed-world",
    "the listener signatures of one event name of one emitter class",
  ),
  scan(
    "frontend/lowering/lower-modules.ts#appendEntryModules",
    1,
    "discovery",
    "the modules the entry reaches, in order",
  ),
  decides(
    "frontend/lowering/lower-server.ts#socketEncodingReachable",
    2,
    "socket-encoding-reachable",
  ),
  decides("frontend/lowering/lower-server.ts#unixListenReachable", 2, "unix-listen-reachable"),
  scan(
    "frontend/lowering/lower-shared-modules.ts#sharedModulePlans",
    1,
    "prefilter",
    "a module that never names requireModule starts no island root",
  ),
  scan(
    "frontend/lowering/lower-stdlib.ts#requestInitPropMutatedSymbols",
    1,
    "closed-world",
    "whether one options object is mutated after its literal",
  ),
  scan(
    "frontend/lowering/lower-stream.ts#propMutatedSymbols",
    1,
    "closed-world",
    "whether one options object is mutated after its literal",
  ),
  scan(
    "frontend/lowering/lowerer.ts#Lowerer",
    1,
    "prefilter",
    "analyzeDateJsonResults: a toJSON call spells `toJSON`; the result types individual bindings",
  ),
  scan(
    "frontend/lowering/native-ffi.ts#validateFfiImports",
    1,
    "discovery",
    "the declarations that carry a configured binding's name",
  ),
  scan(
    "frontend/lowering/open-enumerations.ts#analyzeOpenEnumerations",
    2,
    "prefilter",
    "an enumeration of an open spread value spells `...` and `Object.entries` or `Object.values`; the result types the bindings that take its values",
  ),
  decides(
    "frontend/lowering/partial-assertions.ts#partialTargetOf",
    1,
    "partial-assertion-targets",
  ),
  decides("frontend/lowering/member-call-receivers.ts#takeCensus", 1, "member-call-receivers"),
  decides("frontend/lowering/primitive-wrappers.ts#programCreatesWrappers", 1, "creates-wrappers"),
  scan(
    "frontend/lowering/symbol-fields.ts#tablePropertyWritten",
    2,
    "closed-world",
    "whether one property of one export table is written",
  ),
  decides(
    "frontend/lowering/thenables.ts#programMayDefineThenables",
    2,
    "thenables-may-be-defined",
  ),
  scan(
    "frontend/lowering/unit-reuse.ts#UnitReuse",
    1,
    "key",
    "a digest of the files a reused unit does not own",
  ),
  decides("frontend/node-api-import.ts#programImportsNodeApi", 1, "imports-node-api"),
  scan(
    "frontend/pipeline.ts#addDynamicImportGraph",
    1,
    "prefilter",
    "a dynamic import spells `import`",
  ),
  scan(
    "frontend/pipeline.ts#detectAutoPackages",
    2,
    "discovery",
    "the packages the program requires; the text test skips files without `require`",
  ),
  scan("frontend/pipeline.ts#scanDroppedPackages", 1, "discovery", "the packages a load dropped"),
  scan(
    "frontend/pipeline.ts#loadFrontend",
    2,
    "discovery",
    "the entry contract's files and the source texts of the library identity",
  ),
  scan(
    "frontend/program.ts#createRequireProgramRoots7",
    1,
    "discovery",
    "program roots named by createRequire calls",
  ),
  scan(
    "frontend/program.ts#boundedDynamicImportRoots7",
    1,
    "discovery",
    "program roots named only by a bounded dynamic import()",
  ),
  scan(
    "frontend/program.ts#entryPackageProgramRoots7",
    1,
    "discovery",
    "program roots of the entry package",
  ),
  decides("frontend/program.ts#programNamesTemporal7", 2, "names-temporal"),
  scan(
    "frontend/program.ts#lowerProgramJsx7",
    1,
    "discovery",
    "the files that hold JSX, each lowered on its own",
  ),
  scan(
    "frontend/program.ts#loadProgram7",
    3,
    "discovery",
    "fork and worker targets, which become program roots; and, file by file from the tsconfig above each, the files that compile class fields in the constructor and the legacy decorators refused by name",
  ),
  scan(
    "frontend/program.ts#declBoundaryUserFiles",
    5,
    "discovery",
    "the user files of a declaration-typed boundary",
  ),
  scan(
    "frontend/program.ts#splitRequireBindings7",
    1,
    "prefilter",
    "a split require binding's file has to spell `require`",
  ),
  scan(
    "frontend/program.ts#exportedCreateRequireUseReason7",
    1,
    "closed-world",
    "the importers of one exported createRequire loader",
  ),
  scan("frontend/program.ts#registerWorkspaceEdges", 1, "discovery", "workspace package edges"),
  scan(
    "frontend/program.ts#preflightStructure7",
    7,
    "discovery",
    "the module graph, the evaluation order and the dynamic imports it covers",
  ),
  scan(
    "frontend/shape-inference/analyze.ts#Analyzer",
    1,
    "inference",
    "shapes of individual untyped JavaScript objects",
  ),
  scan(
    "frontend/shape-inference/index.ts#readMemoFor",
    1,
    "key",
    "the memo key of the shape overlay",
  ),
  scan(
    "frontend/shape-inference/index.ts#programTextKey",
    1,
    "key",
    "the memo key of the shape overlay",
  ),
  scan(
    "wasm/discover.ts#Discovery",
    4,
    "discovery",
    "the packages that mention WebAssembly, for the wasm report",
  ),
];

/** The Lowerer fields that cache a registered fact on first use. They are
 * computed again when asked, so a unit's record need not carry them: each
 * is listed in Lowerer.unjournaled. */
export function programFactLowererFields(): string[] {
  return PROGRAM_FACTS.flatMap((fact) => [...fact.lowererFields]);
}
