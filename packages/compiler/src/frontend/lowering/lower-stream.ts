import { keyedHelperName } from "./stable-names.js";
import { nodeThrowExpr, boolLit, numLit, strLit } from "../../ir/build.js";
import { isValueStream, valueStreamOf } from "./builtins/hash-stream.js";
import { InternalCompilerError } from "../../errors.js";
/* The node:stream lowering (the spoke-module pattern, like
 * lower-event-emitter.ts): construction of the five runtime stream classes
 * (`new Readable({ read() {} })` et al — the OPTIONS-OBJECT form), user
 * subclasses (`class My extends Readable { _read() {...} }` — the
 * underscore-override form: super(options) lowers to a stream.init
 * libCall over the already-allocated subclass struct, and overridden
 * underscore methods bind as compiler-synthesized wrapper closures that
 * dispatch through the vtable, so a further-derived override wins even
 * under an inherited constructor), the stream method surface
 * (push/read/pause/resume/pipe/write/end/destroy/...) on stream-rooted
 * receivers, the readableEnded-family property reads, and the per-base
 * FORCED event tuples the emitter spoke consults ('data' is one Buffer,
 * 'pipe'/'unpipe' one Readable, the lifecycle events empty — runtime-
 * emitted payloads must be typed without colliding with user events of
 * the same names on plain emitters; the 'error' forced-tuple precedent,
 * scoped per runtime base).
 *
 * THE TYPING STANCE. Chunks are BYTES: 'data' delivers Buffers, read()
 * answers `Buffer | null`, and push/write accept a Buffer or a utf8
 * string (converted at the call, Node's decodeStrings default).
 * objectMode, setEncoding, and non-utf8 encodings have no static story
 * yet and fence with their own words. Option callbacks (`read`, `write`,
 * `final`, `destroy`, `transform`, `flush`) lower as closures with a
 * LEADING `this` parameter — Node binds `this` to the stream when it
 * calls them, so method-shorthand bodies (`read() { this.push(...) }`)
 * resolve `this` to that parameter; the runtime passes the stream through
 * compiler-emitted invoke adapters. A callback may declare any PREFIX of
 * its Node signature (the emitter listener rule). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dynFallbackType } from "./lowerer.js";
import {
  accessorCall,
  classIteratorNextCall,
  classIteratorOf,
  classIteratorOpenCall,
  type ClassInfo,
  type ClassIteratorInfo,
} from "./lower-classes.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, own } from "./lowerer.js";
import { appendImplicitUndefinedReturn } from "./function-returns.js";
import { bufEncoding, knownBufEncoding } from "./containers/bytes.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { sideEffectFreeOptionValue } from "./surfaces.js";
import { lowerDynObjectLiteral } from "./expressions/object-literals.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { genResultRecord } from "../type-mapper.js";
import { noteUntypedStreamFlow, requestGeneralStreamSurface } from "./general-streams.js";
import { dynNativeBranch } from "./dyn-streams.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { extractIteratorValue, genStep, genValue, stepDrivable } from "./lower-generators.js";
import { LiftedFrame, driveGenerator } from "./containers/iterator-helpers.js";
import { lowerArrayIteratorValue, lowerStringIteratorValue } from "./iterator-adapters.js";
import { staticReadableStreamElementType } from "./lower-stdlib.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLibFn,
  type IrLocal,
  type IrStmt,
  type IrType,
  RUNTIME_STREAM_CLASSES,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  BYTES_U8,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  funcOf,
  typeEquals,
  typeKey,
  UNDEFINED_T,
} from "../../ir/ir.js";

const BYTES = BYTES_U8;

/** An expression that only reads bindings and properties (no calls,
 * assignments or construction): reading it a step later observes the
 * same values. */
function pureRead(node: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node)
  ) {
    return pureRead(node.expression);
  }
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return pureRead(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return (
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression)) &&
      pureRead(node.expression)
    );
  }
  return false;
}

/** A literal, `undefined`, or a function expression: a value that reads
 * no binding or property. */
function constantOptionValue(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertion(e))
    e = e.expression;
  if (ts.isIdentifier(e)) return e.text === "undefined";
  if (
    ts.isPrefixUnaryExpression(e) &&
    (e.operator === ts.SyntaxKind.MinusToken ||
      e.operator === ts.SyntaxKind.PlusToken ||
      e.operator === ts.SyntaxKind.ExclamationToken)
  )
    return constantOptionValue(e.operand);
  return (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e)
  );
}

/** Whether a runtime decodeStrings or defaultEncoding value (`prop`'s
 * `value`) may be read before the other option members. Those values are
 * read into locals before the constructor evaluates the other members,
 * while Node evaluates the members in order, so every earlier member must
 * evaluate without effects, and when the value itself has effects, every
 * earlier member must also read nothing those effects could change. */
function earlierOptionsPure(
  options: ts.ObjectLiteralExpression,
  prop: ts.Node,
  value: ts.Expression,
): boolean {
  const valueHasEffects = !sideEffectFreeOptionValue(value) && !pureRead(value);
  for (const member of options.properties.nodes) {
    if (member === prop) return true;
    if (ts.isPropertyAssignment(member)) {
      const init = member.initializer;
      if (
        valueHasEffects
          ? !constantOptionValue(init)
          : !sideEffectFreeOptionValue(init) && !pureRead(init)
      )
        return false;
    } else if (ts.isShorthandPropertyAssignment(member)) {
      if (valueHasEffects) return false;
    } else if (ts.isSpreadAssignment(member)) return false;
  }
  return true;
}

/** The stream sides of a receiver class: the nearest stream-class
 * ancestor's, or null off the stream hierarchy. */
export function streamSidesOf(
  lowerer: Lowerer,
  info: ClassInfo | undefined | null,
): "r" | "w" | "rw" | null {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.builtinStream) return c.builtinStream;
  }
  return null;
}

/** The instance members the stream spoke owns on stream-rooted
 * receivers (the emitter members ride the base chain as usual). */
export const STREAM_API_MEMBERS: ReadonlySet<string> = new Set([
  "push",
  "unshift",
  "read",
  "pause",
  "resume",
  "isPaused",
  "setEncoding",
  "pipe",
  "unpipe",
  "destroy",
  "write",
  "end",
  "cork",
  "uncork",
  "setDefaultEncoding",
]);

/** The property names the stream spoke owns (lowerStreamProperty) — a
 * subclass field or accessor with one of these names would split-brain
 * against the runtime state, so collection fences them (the
 * EMITTER_API_MEMBERS precedent). */
export const STREAM_PROP_MEMBERS: ReadonlySet<string> = new Set([
  "readable",
  "readableEnded",
  "readableFlowing",
  "readableLength",
  "readableHighWaterMark",
  "readableObjectMode",
  "writable",
  "writableEnded",
  "writableFinished",
  "writableNeedDrain",
  "writableLength",
  "writableHighWaterMark",
  "writableCorked",
  "writableObjectMode",
  "destroyed",
  "closed",
  "errored",
  "allowHalfOpen",
]);

/** The underscore methods each runtime base consumes at construction
 * (option-callback name → method name). A stream subclass declaring an
 * underscore method OUTSIDE its base's set (a `_read` on a Transform,
 * `_writev`/`_construct` anywhere) is fenced at collection: Node would
 * consume it through machinery that has no lowering here. */
export const UNDERSCORE_METHODS: ReadonlyMap<string, string> = new Map([
  ["read", "_read"],
  ["write", "_write"],
  ["final", "_final"],
  ["destroy", "_destroy"],
  ["transform", "_transform"],
  ["flush", "_flush"],
]);

/** The option callbacks applied after construction rather than through
 * the constructor's callback slots (option name → method name): construct
 * on every stream class, and writev on every class with a writable side
 * (a Transform's batches reach writev, not the transform, as in Node). */
export const STREAM_EXTRA_CALLBACKS: ReadonlyMap<string, string> = new Map([
  ["construct", "_construct"],
  ["writev", "_writev"],
]);

export function streamExtraCallbacks(cls: string): readonly string[] {
  return cls === "%Readable" ? ["construct"] : ["construct", "writev"];
}

/** The completion callback's parameter position in each underscore
 * method that takes one (cbTuples' "fn" positions). */
export const STREAM_COMPLETION_CALLBACK_INDEX: ReadonlyMap<string, number> = new Map([
  ["_write", 2],
  ["_writev", 1],
  ["_construct", 0],
  ["_final", 0],
  ["_destroy", 1],
  ["_transform", 2],
  ["_flush", 0],
]);

/** The accepted option-callback names (canonical flag order) and the
 * duplex-shaped-head answer for one runtime stream class. */
export function streamCtorShape(cls: string): {
  fn: string;
  accepted: readonly string[];
  duplexShape: boolean;
} {
  switch (cls) {
    case "%Readable":
      return { fn: "readable", accepted: ["read", "destroy"], duplexShape: false };
    case "%Writable":
      return { fn: "writable", accepted: ["write", "final", "destroy"], duplexShape: false };
    case "%Duplex":
      return { fn: "duplex", accepted: ["read", "write", "final", "destroy"], duplexShape: true };
    case "%Transform":
      return { fn: "transform", accepted: ["transform", "flush", "destroy"], duplexShape: true };
    case "%PassThrough":
      return { fn: "passthrough", accepted: ["transform", "flush", "destroy"], duplexShape: true };
    default:
      throw new InternalCompilerError(`lowerer bug: streamCtorShape of ${cls}`);
  }
}

/** Names emitted internally by stream runtimes. A computed EventEmitter
 * name must not match one, even through an EventEmitter-typed stream upcast. */
export const STREAM_FORCED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "data",
  "end",
  "close",
  "readable",
  "pause",
  "resume",
  "drain",
  "prefinish",
  "finish",
  "pipe",
  "unpipe",
  "open",
  "ready",
  "keypress",
]);

/** The per-base FORCED event tuples (runtime-emitted payloads): consulted
 * by the emitter spoke BEFORE the program-global table, so a stream's
 * 'data' never collides with a user event named 'data' on a plain
 * emitter. 'error' stays globally forced to the one-%Error tuple. */
export function streamForcedTuple(
  lowerer: Lowerer,
  info: ClassInfo | undefined | null,
  name: string,
): IrType[] | null {
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  // 'open' (the fd) and 'ready' are fs.ReadStream / fs.WriteStream's
  // (scr_fs_stream.c).
  const readable: Record<string, IrType[]> = {
    data: [BYTES],
    end: [],
    close: [],
    readable: [],
    pause: [],
    resume: [],
    open: [F64],
    ready: [],
    // readline.emitKeypressEvents' (str, key), as checked-dynamic values
    keypress: [DYN, DYN],
  };
  const writable: Record<string, IrType[]> = {
    open: [F64],
    ready: [],
    drain: [],
    prefinish: [],
    finish: [],
    close: [],
    pipe: [{ kind: "object", className: "%Readable" }],
    unpipe: [{ kind: "object", className: "%Readable" }],
  };
  // own(), not `in`: `name` is a USER-written event name, and
  // `"toString" in readable` answers true through Object.prototype.
  if (sides === "r" || sides === "rw") {
    const tuple = own(readable, name);
    if (tuple) return tuple;
  }
  if (sides === "w" || sides === "rw") {
    const tuple = own(writable, name);
    if (tuple) return tuple;
  }
  return null;
}
/* ── option callbacks (the leading-`this` closures) ─────────────────── */

/** Lowers one option callback (method shorthand, function expression, or
 * arrow) into a closure whose lifted function takes the STREAM as a
 * leading `this` parameter. Method/function bodies bind `this` to it
 * (Node calls them stream-bound); arrows keep lexical `this` (the hidden
 * leading param is ABI-only). The declared parameters must be a
 * typeEquals PREFIX of the callback's Node signature. */
function lowerStreamCallback(
  lowerer: Lowerer,
  which: string,
  node: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  thisType: IrType,
  fullTuple: IrType[],
  chunkValues = true,
): IrExpr {
  const loc = locOf(node);
  const { shapes, funcType } = lowerer.lambdaSignature(node);
  if (node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    lowerer.unsupported("SC1090", node, `async stream '${which}' callbacks`);
  }
  if (funcType.params.length > fullTuple.length) {
    lowerer.noLowering(
      `a '${which}' callback declaring ${funcType.params.length} parameters where Node passes ${fullTuple.length}`,
      node,
      "stream option callbacks may declare a prefix of their Node signature",
    );
  }
  for (let i = 0; i < funcType.params.length; i++) {
    // A checked-dynamic parameter (the JS lane's implicitly-any
    // callbacks) takes whatever Node passes — the emitted invoke thunk
    // boxes each position by kind (the completion callback arrives as a
    // callable dyn whose glue dispatches to the runtime's *_done).
    if (funcType.params[i]!.kind === "dyn") continue;
    // A write or transform chunk of another type converts from the
    // chunk's value when the callback runs (an object-mode side's value),
    // or throws a TypeError there — on a side known to be byte mode the
    // chunk is a Buffer, so the declared type must be Node's or a
    // supertype of it (`Buffer | string`); an encoding of another type
    // (`string | null | undefined`) converts from the encoding argument's
    // value.
    if (
      ((((i === 0 &&
        (chunkValues || widensInto(lowerer, fullTuple[0]!, funcType.params[0]!, loc))) ||
        i === 1) &&
        (which === "write" || which === "transform")) ||
        (i === 0 && which === "writev")) &&
      funcType.params[i]!.kind !== "func" &&
      canConvertToDyn(
        funcType.params[i]!,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      continue;
    if (!typeEquals(funcType.params[i]!, fullTuple[i]!)) {
      lowerer.noLowering(
        `a '${which}' callback whose parameter ${i} is '${lowerer.fmt(funcType.params[i]!)}' where Node passes '${lowerer.fmt(fullTuple[i]!)}'`,
        node,
        "annotate the parameter with the Node signature's type (chunks are Buffers here)",
      );
    }
  }
  const fnName = lowerer.closureName(loc, `_${which}cb`);
  const fnCtx = newFnCtx(true, null, funcType, funcType.ret);
  lowerer.fnStack.push(fnCtx);
  try {
    // Method shorthand and function expressions see the stream as `this`
    // (Node binds it); arrows keep lexical `this`, so their slot is a
    // hidden ABI local no body reference can resolve to.
    const thisLocal = ts.isArrowFunction(node)
      ? lowerer.declareHiddenLocal("this", thisType)
      : lowerer.declareThis(thisType);
    const { params, prologue } = lowerer.declareParams(node.parameters.nodes, shapes);
    let body: IrStmt[];
    if (node.body !== undefined && ts.isBlock(node.body)) {
      body = lowerer.lowerStmts(node.body.statements.nodes);
    } else if (node.body !== undefined) {
      // Bare-expression bodies (`read: () => this.push(null)`): the value
      // is discarded when the signature returns void — Node ignores
      // option-callback results either way.
      const bodyExpr = node.body as ts.Expression;
      if (funcType.ret.kind === "void") {
        body = [{ kind: "exprStmt", expr: lowerer.lowerExpr(bodyExpr), loc: locOf(node.body) }];
      } else {
        const value = lowerer.lowerExpr(bodyExpr);
        body = [
          {
            kind: "return",
            value: lowerer.coerceInto(bodyExpr, value, funcType.ret),
            loc: locOf(node.body),
          },
        ];
      }
    } else {
      body = [];
    }
    body = [...prologue, ...body];
    appendImplicitUndefinedReturn(lowerer, body, funcType.ret, loc);
    const ctx = lowerer.ctx;
    const lifted: IrFunction = {
      name: fnName,
      params: [{ localId: thisLocal.id, name: "this", type: thisType }, ...params],
      returnType: funcType.ret,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    };
    lowerer.liftedFns.push(lifted);
    return {
      kind: "closure",
      fnName,
      captures: ctx.captureSources,
      type: funcOf([thisType, ...funcType.params], funcType.ret),
      loc,
    };
  } finally {
    lowerer.fnStack.pop();
  }
}

/* ── construction ─────────────────────────────────────────────────────── */

interface StreamOptions {
  hwmR: IrExpr;
  hwmW: IrExpr;
  autoDestroy: IrExpr;
  emitClose: IrExpr;
  allowHalfOpen: IrExpr;
  /** Duplex side toggles ({ readable: false } drops the readable half) —
   * compile-time literals only. */
  readableSide: boolean;
  writableSide: boolean;
  /** The readable-side `encoding` option (canonical name, literal-only):
   * lowered as a setEncoding immediately after construction (Node's
   * ReadableState builds the decoder up front; the buffer is empty at
   * that point, so the two are equivalent). */
  encoding: string | null;
  /** A LITERAL encoding/defaultEncoding spelling Node does not know: the
   * construction lowers to Node's runtime ERR_UNKNOWN_ENCODING TypeError
   * (the state constructors validate encodings up front). */
  badEncoding: string | null;
  /** A Readable's valid non-utf8 `defaultEncoding` (canonical): applied
   * as a follow-up readable.pushEncoding — push(string) decodes through
   * it (Node's Buffer.from(chunk, state.defaultEncoding)). */
  pushEncoding: string | null;
  /** The `signal` option's value: applied with stream.addAbortSignal
   * right after construction (Node's constructors call addAbortSignal
   * once the state exists), or null when absent. */
  signal: IrExpr | null;
  /** Non-literal decodeStrings and defaultEncoding values: valueDecls
   * evaluates them into locals before construction (the defaultEncoding
   * validated there, as the state constructors throw before the stream
   * exists), and stream.optionValues applies them to the fresh stream. */
  valueDecls: IrStmt[];
  decodeStringsValue: IrExpr | null;
  defaultEncodingValue: IrExpr | null;
  /** The objectMode option's sides (a Duplex's readableObjectMode and
   * writableObjectMode set one side): applied with stream.objectMode
   * right after construction. */
  readableObject: boolean;
  writableObject: boolean;
  /** decodeStrings: false (string writes stay strings), applied with
   * stream.decodeStrings right after construction. */
  decodeStringsOff: boolean;
  /** A writable side's non-utf8 `defaultEncoding` as written, applied
   * with writable.writeEncoding. */
  writeEncoding: string | null;
  /** The construct and writev callbacks (options or the class's
   * _construct/_writev), applied with stream.setWritev and
   * stream.setConstruct right after construction. */
  extras: { name: string; cb: IrExpr }[];
  /** Present callbacks in canonical order with their flag bits. */
  flags: number;
  cbs: IrExpr[];
}

/** The objectMode, readableObjectMode and writableObjectMode members of a
 * stream options literal (boolean literals; the sided keys count only on
 * a Duplex, Transform or PassThrough, as in Node). */
function streamObjectModes(
  lowerer: Lowerer,
  ctorName: string,
  optsLit: ts.ObjectLiteralExpression | undefined,
): { readable: boolean; writable: boolean } {
  const out = { readable: false, writable: false };
  const duplexish = ctorName !== "Readable" && ctorName !== "Writable";
  for (const prop of optsLit?.properties?.nodes ?? []) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (name !== "objectMode" && name !== "readableObjectMode" && name !== "writableObjectMode")
      continue;
    const value = prop.initializer;
    if (value.kind === ts.SyntaxKind.FalseKeyword) continue;
    if (value.kind !== ts.SyntaxKind.TrueKeyword) {
      lowerer.noLowering(
        `${ctorName} with a runtime '${name}' value`,
        prop,
        `write '${name}: true' or '${name}: false'`,
      );
    }
    if (name === "objectMode") {
      out.readable = true;
      out.writable = true;
    } else if (duplexish) {
      if (name === "readableObjectMode") out.readable = true;
      else out.writable = true;
    }
  }
  return out;
}

/** Whether an options literal makes the writable side hold values: its
 * object mode set with a `true` literal (objectMode, or writableObjectMode
 * on a duplex stream), or decodeStrings: false (strings stay strings).
 * Reports nothing: the options parse fences the other value forms. */
function literalWritesValues(opts: ts.ObjectLiteralExpression, duplexish: boolean): boolean {
  for (const prop of opts.properties?.nodes ?? []) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null;
    if (name === "decodeStrings") {
      if (prop.initializer.kind !== ts.SyntaxKind.TrueKeyword) return true;
      continue;
    }
    if (name !== "objectMode" && !(duplexish && name === "writableObjectMode")) continue;
    if (prop.initializer.kind !== ts.SyntaxKind.FalseKeyword) return true;
  }
  return false;
}

/** The full Node parameter tuples of the option callbacks, given the
 * concrete stream's `this` type. The trailing completion callbacks keep
 * whatever func type the checker contextually gave the user's parameter
 * (the emitted adapter constructs a matching closure), so only their
 * FUNC-ness is checked here. */
function cbTuples(lowerer: Lowerer): Record<string, (IrType | "fn")[]> {
  return {
    read: [F64],
    write: [BYTES, STRING, "fn"],
    final: ["fn"],
    construct: ["fn"],
    writev: [DYN, "fn"],
    destroy: [errorOrNull(lowerer), "fn"],
    transform: [BYTES, STRING, "fn"],
    flush: ["fn"],
  };
}

/** Interns a union from unsorted arms (the interner's identity is the
 * typeKey-SORTED arm list — mapType's canonicalization). */
function unionOf(lowerer: Lowerer, arms: IrType[]): IrType {
  const sorted = [...arms].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: lowerer.unions.intern(sorted) };
}

function errorOrNull(lowerer: Lowerer): IrType {
  return unionOf(lowerer, [{ kind: "object", className: "%Error" }, { kind: "nullT" }]);
}

/** The program's property-mutated symbols (`opts.read = f`, `opts["x"]
 * op= v`, `delete opts.y`): a const-initialized options record whose
 * symbol appears here cannot be followed to its literal — the runtime
 * record and the compile-time walk would split-brain. Built once, lazily
 * (the emitterEvents pre-pass precedent); the scan is diagnostic-free. */
function propMutatedSymbols(lowerer: Lowerer): Set<ts.Symbol> {
  if (lowerer.streamPropMutatedSyms) return lowerer.streamPropMutatedSyms;
  const set = new Set<ts.Symbol>();
  const noteBase = (target: ts.Expression): void => {
    let base = target;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
      base = base.expression;
    }
    if (!ts.isIdentifier(base)) return;
    try {
      const sym = lowerer.resolveValueSymbol(base);
      if (sym) set.add(sym);
    } catch {
      /* not a candidate */
    }
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      ts.forEachChild(node, walk);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        noteBase(node.left);
      } else if (ts.isDeleteExpression(node)) {
        noteBase(node.expression);
      }
    };
    walk(sf);
  }
  lowerer.streamPropMutatedSyms = set;
  return set;
}

/** Follows a non-literal options argument to its compile-time object
 * literal: a chain of const-declared, initialized variables ending at an
 * object literal (`const opts = { read() {} }; new Readable(opts)`).
 * Lowering the SAME literal at every construction site is sound for
 * scoping — the declaration's scope is an ancestor of every use site, so
 * each identifier in a callback body resolves to the identical binding
 * and captures it the ordinary way — and sound for identity because a
 * followed symbol is checked against the program's property mutations
 * (propMutatedSymbols). Returns the argument unchanged when the chain
 * breaks; `undefined`/null arguments answer null (Node's `if (options)`
 * guard — all defaults). */
function followOptionsArg(
  lowerer: Lowerer,
  arg: ts.Expression | undefined,
): ts.Expression | null | undefined {
  let node: ts.Expression | undefined = arg;
  for (let hops = 0; node !== undefined && hops < 16; hops++) {
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isParenthesizedExpression(node)) {
      node = node.expression;
      continue;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (!ts.isIdentifier(node)) return node;
    if (node.text === "undefined") return null;
    let sym: ts.Symbol | null;
    try {
      sym = lowerer.resolveValueSymbol(node);
    } catch {
      return node;
    }
    const decl = sym ? sym.valueDeclaration : undefined;
    if (!sym || !decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined)
      return node;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return node;
    if (propMutatedSymbols(lowerer).has(sym)) return node;
    node = decl.initializer;
  }
  return node;
}

/** A callback slot holding a VALUE instead of an inline function (`read:
 * common.mustCall(fn)`, `{ write: myWrite }`): the value adapts through
 * the checked-dynamic function boundary exactly like dyn listeners —
 * boxed to dyn (statically-typed functions via dynFrom, checked-dynamic
 * values as they are), then dynCheck'd into the all-dyn full Node tuple.
 * The emitted option thunk recognizes the THISLESS shape (its first
 * param is not the stream) and boxes each position by kind — the chunk
 * as dyn bytes, the error via the boundary's encoding, the completion
 * callback as a callable dyn whose glue reports to the runtime's *_done.
 * DIVERGENCE (SEMANTICS.md): Node binds `this` to the stream when it
 * calls option callbacks; a value adapted through the dyn boundary is
 * called with `this` undefined (the dyn call ABI carries no receiver) —
 * reference the stream through a lexical binding instead. */
function lowerStreamCallbackValue(
  lowerer: Lowerer,
  ctorName: string,
  which: string,
  node: ts.Expression,
  fullLen: number,
): IrExpr {
  const loc = locOf(node);
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(node);
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, node, ct);
  } catch {
    t = null;
  }
  let cbDyn: IrExpr;
  if (t?.kind === "dyn") {
    const v = lowerer.lowerExpr(node);
    cbDyn = v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc };
  } else if (t?.kind === "func") {
    const cb = lowerer.lowerExpr(node);
    // JavaScript globals may keep callable values in checked storage even
    // when the checker can describe their function signature.
    if (cb.type.kind === "dyn") {
      cbDyn = cb;
    } else if (cb.type.kind === "func" && canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      cbDyn = { kind: "dynFrom", value: cb, type: DYN, loc };
    } else {
      lowerer.noLowering(
        `the ${ctorName} option '${which}' with a function value of this signature`,
        node,
        "a callback value's own parameters and return must cross the checked-dynamic boundary — write the callback inline to keep it fully static",
      );
    }
  } else {
    lowerer.noLowering(
      `the ${ctorName} option '${which}' with a non-function value`,
      node,
      "the callback slot takes an inline function (fully static) or a function value that crosses the checked-dynamic boundary",
    );
  }
  const adapterT = funcOf(
    Array.from({ length: fullLen }, () => DYN),
    VOID,
  );
  return { kind: "dynCheck", value: cbDyn, type: adapterT, loc };
}

/** A checked-dynamic options VALUE (the JS lane's `super(options)`
 * forwarding a constructor parameter, `new Readable(dynVar)`): the
 * record's shape is runtime data, so the option walk runs in the runtime
 * (the `.newDyn`/`.initDyn` twins) with Node's own reading rules. Null
 * when the argument is not dyn-flavored (the static walk owns it). */
function dynOptionsValue(lowerer: Lowerer, arg: ts.Expression): IrExpr | null {
  const followed = followOptionsArg(lowerer, arg);
  if (followed === null || followed === undefined || ts.isObjectLiteralExpression(followed))
    return null;
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(followed);
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, followed, ct);
  } catch {
    return null;
  }
  if (t?.kind !== "dyn") return null;
  const v = lowerer.lowerExpr(followed);
  return v.type.kind === "dyn" ? v : null;
}

/** @types/node declares the transform/flush completion callback as
 * `(error?: Error | null, data?: any) => void`. Outside objectMode Node
 * accepts only a Buffer, a string or nothing as `data`, so the callback
 * parameter is typed with that union while the option callback lowers: a
 * checked-dynamic value passed as `data` converts at the call. Returns the
 * pinned parameter symbol (the caller unpins it), or null when the
 * declared type needs no pin. */
function pinAnyDataCompletion(
  lowerer: Lowerer,
  which: string,
  fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): ts.Symbol | null {
  const index = which === "transform" ? 2 : which === "flush" ? 0 : -1;
  const param = index < 0 ? undefined : fnNode.parameters.nodes[index];
  if (param === undefined || !ts.isIdentifier(param.name) || param.dotDotDotToken) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(param.name);
  if (!symbol || lowerer.stageSourceTypes.has(symbol)) return null;
  const declared = lowerer.paramShape(param).type;
  if (declared.kind !== "func" || declared.rest || declared.params[1]?.kind !== "dyn") return null;
  // Only when every use calls the callback with a Buffer, a string or
  // nothing as `data`: another value (or a callback that escapes) keeps
  // `data` checked-dynamic, so the runtime pushes it as push(data) does
  // and reports ERR_INVALID_ARG_TYPE through 'error', as Node does.
  if (fnNode.body === undefined || !completionDataIsChunk(lowerer, fnNode.body, symbol, param.name))
    return null;
  const data = unionOf(lowerer, [BYTES, STRING, { kind: "undefinedT" }]);
  lowerer.stageSourceTypes.set(
    symbol,
    funcOf([declared.params[0]!, data, ...declared.params.slice(2)], declared.ret),
  );
  return symbol;
}

/** Whether every reference to the completion callback `symbol` in `body`
 * calls it with a `data` argument that is a Buffer, a string, null or
 * undefined (or with no data). */
function completionDataIsChunk(
  lowerer: Lowerer,
  body: ts.Node,
  symbol: ts.Symbol,
  declaration: ts.Node,
): boolean {
  let ok = true;
  const visit = (node: ts.Node): void => {
    if (!ok) return;
    if (
      ts.isIdentifier(node) &&
      node !== declaration &&
      lowerer.checker.getSymbolAtLocation(node) === symbol
    ) {
      const call = node.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== node) {
        ok = false;
        return;
      }
      const data = call.arguments.nodes[1];
      if (data !== undefined) {
        let t: IrType | null;
        try {
          t = lowerer.mapTypeOf(lowerer.typeOf(data));
        } catch {
          t = null;
        }
        const arms =
          t?.kind === "union" ? (lowerer.unions.get(t.unionId)?.arms ?? null) : t ? [t] : null;
        if (
          arms === null ||
          !arms.every(
            (a) =>
              (a.kind === "bytes" && a.elem === "u8") ||
              a.kind === "string" ||
              a.kind === "undefinedT" ||
              a.kind === "nullT",
          )
        ) {
          ok = false;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return ok;
}

/** Parses the options object literal of a stream constructor. `which`
 * names the callbacks this class accepts, in canonical flag order. */
function parseStreamOptions(
  lowerer: Lowerer,
  ctorName: string,
  arg: ts.Expression | undefined,
  thisType: IrType,
  accepted: readonly string[],
  loc: SrcLoc,
  /** Subclass construction: the wrapper closure for an overridden
   * underscore method, consulted for callbacks the options did not
   * provide (an options callback shadows the method, Node's instance-
   * property rule). */
  fallbackCb?: (name: string) => IrExpr | null,
): StreamOptions {
  const out: StreamOptions = {
    hwmR: numLit(-1, loc),
    hwmW: numLit(-1, loc),
    autoDestroy: boolLit(true, loc),
    emitClose: boolLit(true, loc),
    allowHalfOpen: boolLit(true, loc),
    readableSide: true,
    writableSide: true,
    encoding: null,
    badEncoding: null,
    pushEncoding: null,
    signal: null,
    valueDecls: [],
    decodeStringsValue: null,
    defaultEncodingValue: null,
    readableObject: false,
    writableObject: false,
    decodeStringsOff: false,
    writeEncoding: null,
    extras: [],
    flags: 0,
    cbs: [],
  };
  const extraNames = streamExtraCallbacks(`%${ctorName}`);
  const writableClass = ctorName !== "Readable";
  const followed = followOptionsArg(lowerer, arg);
  const optsLit = followed === null ? undefined : followed;
  if (optsLit !== undefined && !ts.isObjectLiteralExpression(optsLit)) {
    lowerer.noLowering(
      `new ${ctorName} with a non-literal options argument`,
      optsLit,
      "the options must be an object literal, inline or through const-initialized bindings (the callbacks lower as compile-time closures)",
    );
  }
  // Read before the callbacks lower: an object-mode readable side keeps a
  // completion callback's `data: any` (its values are not only strings and
  // Buffers). An object-mode side's high-water mark defaults to 16.
  const objectModes = streamObjectModes(
    lowerer,
    ctorName,
    optsLit !== undefined && ts.isObjectLiteralExpression(optsLit) ? optsLit : undefined,
  );
  out.readableObject = objectModes.readable;
  out.writableObject = objectModes.writable;
  // the chunk an option callback receives can be another value than a
  // Buffer (literalWritesValues), read before any callback lowers
  const writesValues =
    optsLit !== undefined &&
    ts.isObjectLiteralExpression(optsLit) &&
    literalWritesValues(optsLit, ctorName !== "Readable" && ctorName !== "Writable");
  // In JavaScript a decodeStrings value known only at run time may let
  // string writes through, so the write and transform callbacks' chunk
  // parameters read as any (the declarations type it Buffer).
  const runtimeDecodeStrings =
    optsLit !== undefined &&
    isJsSourceFile(ts.getSourceFileOfNode(optsLit)) &&
    ts.isObjectLiteralExpression(optsLit) &&
    (optsLit.properties?.nodes ?? []).some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === "decodeStrings" &&
        p.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
        p.initializer.kind !== ts.SyntaxKind.FalseKeyword,
    );
  if (out.readableObject) out.hwmR = numLit(16, loc);
  if (out.writableObject) out.hwmW = numLit(16, loc);
  const tuples = cbTuples(lowerer);
  const present = new Map<string, IrExpr>();
  for (const prop of optsLit?.properties?.nodes ?? []) {
    const propName = ts.isSpreadAssignment(prop) ? undefined : prop.name;
    const name =
      propName && ts.isIdentifier(propName)
        ? propName.text
        : propName && ts.isStringLiteral(propName)
          ? propName.text
          : null;
    if (name === null) {
      lowerer.unsupported("SC1090", prop, `computed or spread members in ${ctorName} options`);
    }
    // Callback members: shorthand methods and function-valued properties.
    if (accepted.includes(name) || extraNames.includes(name)) {
      let fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null = null;
      if (ts.isMethodDeclaration(prop)) fnNode = prop;
      else if (
        ts.isPropertyAssignment(prop) &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        fnNode = prop.initializer;
      }
      if (!fnNode) {
        // A callback VALUE (`read: common.mustCall(fn)`, `{ write:
        // myWrite }`, shorthand `{ read }`): adapt through the checked-
        // dynamic function boundary (the dyn-listener precedent).
        const valueNode = ts.isPropertyAssignment(prop)
          ? prop.initializer
          : ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)
            ? prop.name
            : null;
        if (valueNode === null) {
          lowerer.noLowering(
            `the ${ctorName} option '${name}' as this member form`,
            prop,
            "write the callback inline (method shorthand or an inline function/arrow), or pass a function value",
          );
        }
        present.set(
          name,
          lowerStreamCallbackValue(lowerer, ctorName, name, valueNode, tuples[name]!.length),
        );
        continue;
      }
      const full = tuples[name]!.map((t) => (t === "fn" ? null : t));
      const pinned = out.readableObject ? null : pinAnyDataCompletion(lowerer, name, fnNode);
      let anyChunk: ts.Symbol | undefined;
      try {
        // The completion-callback tail: typed by the checker contextually;
        // accept the user's declared func type as the tuple's entry so the
        // prefix check compares like with like.
        const { funcType } = lowerer.lambdaSignature(fnNode);
        const tuple: IrType[] = full.map((t, i) => {
          if (t !== null) return t;
          const declared = funcType.params[i];
          if (declared !== undefined && declared.kind !== "func" && declared.kind !== "dyn") {
            lowerer.noLowering(
              `a '${name}' callback whose parameter ${i} is '${lowerer.fmt(declared)}' where Node passes the completion callback`,
              fnNode!,
            );
          }
          return declared ?? funcOf([], VOID);
        });
        const chunkParam =
          runtimeDecodeStrings && (name === "write" || name === "transform")
            ? fnNode.parameters.nodes[0]
            : undefined;
        anyChunk =
          chunkParam !== undefined && ts.isIdentifier(chunkParam.name) && !chunkParam.type
            ? lowerer.checker.getSymbolAtLocation(chunkParam.name)
            : undefined;
        if (anyChunk) lowerer.anySymbols.add(anyChunk);
        present.set(
          name,
          lowerStreamCallback(lowerer, name, fnNode, thisType, tuple, writesValues),
        );
      } finally {
        if (pinned) lowerer.stageSourceTypes.delete(pinned);
        if (anyChunk) lowerer.anySymbols.delete(anyChunk);
      }
      continue;
    }
    // `{ signal }` shorthand: the binding is the value.
    if (name === "signal" && ts.isShorthandPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name)) out.signal = lowerer.lowerExprExpecting(prop.name, DYN);
      continue;
    }
    // Scalar options.
    if (!ts.isPropertyAssignment(prop)) {
      lowerer.unsupported(
        "SC1090",
        prop,
        `the ${ctorName} option '${name}' as a shorthand/method member`,
      );
    }
    const value = prop.initializer;
    switch (name) {
      case "highWaterMark": {
        const v = lowerer.lowerExprExpecting(value, F64);
        out.hwmR = v;
        out.hwmW = v;
        break;
      }
      case "readableHighWaterMark":
        out.hwmR = lowerer.lowerExprExpecting(value, F64);
        break;
      case "writableHighWaterMark":
        out.hwmW = lowerer.lowerExprExpecting(value, F64);
        break;
      case "autoDestroy":
        out.autoDestroy = lowerer.lowerExprExpecting(value, BOOL);
        break;
      case "emitClose":
        out.emitClose = lowerer.lowerExprExpecting(value, BOOL);
        break;
      case "allowHalfOpen":
        out.allowHalfOpen = lowerer.lowerExprExpecting(value, BOOL);
        break;
      case "objectMode":
      case "readableObjectMode":
      case "writableObjectMode":
        // read up front (streamObjectModes)
        break;
      case "decodeStrings": {
        // WritableState's `options.decodeStrings === false`; a Readable
        // ignores the option
        if (value.kind === ts.SyntaxKind.TrueKeyword) break; // Node's default
        if (value.kind === ts.SyntaxKind.FalseKeyword) {
          if (writableClass) out.decodeStringsOff = true;
          break;
        }
        // a runtime value: WritableState's `options.decodeStrings !== false`
        if (
          optsLit !== undefined &&
          ts.isObjectLiteralExpression(optsLit) &&
          !earlierOptionsPure(optsLit, prop, value)
        )
          lowerer.noLowering(
            `the ${ctorName} option 'decodeStrings' with a runtime value that an earlier option value could observe or change`,
            prop,
            "compute the option values into consts before the options object (the runtime value is read before the other options run)",
          );
        const local = lowerer.declareHiddenLocal("%decodeStrings", DYN);
        out.valueDecls.push({
          kind: "varDecl",
          localId: local.id,
          init: lowerer.lowerExprExpecting(value, DYN),
          loc,
        });
        if (writableClass) out.decodeStringsValue = varRef(local.id, DYN, loc);
        break;
      }
      case "encoding": {
        // The readable-side string-chunk mode: a literal encoding, folded
        // to its canonical name (Writable has no such option). A literal
        // spelling Node does not know is Node's RUNTIME rejection —
        // ERR_UNKNOWN_ENCODING at construction, not a compile fence.
        if (ctorName === "Writable") lowerer.noLowering(`the Writable option 'encoding'`, prop);
        {
          const t = lowerer.typeOf(value);
          if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
            out.badEncoding = t.value;
            break;
          }
        }
        out.encoding = bufEncoding(lowerer, `the ${ctorName} option 'encoding'`, value);
        break;
      }
      case "defaultEncoding":
        // utf8 is the byte default — admit the literal. A literal Node
        // does not know throws ERR_UNKNOWN_ENCODING at construction (the
        // state ctor validates it), Node's ladder. On a pure Readable a
        // valid non-utf8 name governs how push(string) DECODES chunks
        // (Buffer.from(chunk, enc)) — lowered as a follow-up
        // readable.pushEncoding. The write-side meaning (what
        // write(string) does) stays fenced on the writable classes.
        {
          const t = lowerer.typeOf(value);
          if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) break;
          if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
            out.badEncoding = t.value;
            break;
          }
          if (t.isStringLiteralType()) {
            // the readable side decodes push(string) with it, and the
            // writable side encodes write(string) with it (the name as
            // written reaches _write when decodeStrings is false)
            if (ctorName !== "Writable" && !out.readableObject)
              out.pushEncoding = knownBufEncoding(t.value)!;
            if (writableClass) out.writeEncoding = t.value;
            break;
          }
        }
        {
          // a runtime value: null, undefined and utf8 are the default,
          // another name Buffer.isEncoding knows is kept as given, and any
          // other value throws ERR_UNKNOWN_ENCODING before construction
          if (
            optsLit !== undefined &&
            ts.isObjectLiteralExpression(optsLit) &&
            !earlierOptionsPure(optsLit, prop, value)
          )
            lowerer.noLowering(
              `the ${ctorName} option 'defaultEncoding' with a runtime value that an earlier option value could observe or change`,
              prop,
              "compute the option values into consts before the options object (the runtime value is read before the other options run)",
            );
          const local = lowerer.declareHiddenLocal("%defaultEncoding", DYN);
          const ref = varRef(local.id, DYN, loc);
          out.valueDecls.push(
            {
              kind: "varDecl",
              localId: local.id,
              init: lowerer.lowerExprExpecting(value, DYN),
              loc,
            },
            {
              kind: "exprStmt",
              expr: {
                kind: "libCall",
                fn: "stream.checkEncodingOption",
                args: [ref],
                type: VOID,
                loc,
              },
              loc,
            },
          );
          out.defaultEncodingValue = ref;
        }
        break;
      case "signal": {
        // `if (options.signal) addAbortSignal(options.signal, this)`:
        // applied over the fresh stream, so the value is read after the
        // constructor — only values whose evaluation has no effects.
        if (value.kind === ts.SyntaxKind.NullKeyword) break;
        if (ts.isIdentifier(value) && value.text === "undefined") break;
        if (!sideEffectFreeOptionValue(value) && !pureRead(value)) {
          lowerer.noLowering(
            `the ${ctorName} option 'signal' with this value`,
            prop,
            "pass a variable or property read (const signal = controller.signal) — the signal is read after construction",
          );
        }
        out.signal = lowerer.lowerExprExpecting(value, DYN);
        break;
      }
      case "captureRejections": {
        // `false` is the default — admit the literal; the rejection-
        // capturing mode has no lowering (async listeners' promises are
        // abandoned unobserved).
        if (value.kind === ts.SyntaxKind.FalseKeyword) break;
        lowerer.noLowering(
          `the ${ctorName} option 'captureRejections'`,
          prop,
          "captureRejections has no lowering (listener rejections are not routed to 'error')",
        );
        break;
      }
      case "readable":
      case "writable": {
        // Duplex side toggles: compile-time literals only (they decide
        // which halves EXIST).
        if (ctorName !== "Duplex") {
          lowerer.noLowering(`the ${ctorName} option '${name}'`, prop);
        }
        if (value.kind === ts.SyntaxKind.TrueKeyword) break;
        if (value.kind === ts.SyntaxKind.FalseKeyword) {
          if (name === "readable") out.readableSide = false;
          else out.writableSide = false;
          break;
        }
        lowerer.noLowering(
          `the Duplex option '${name}' with a non-literal value`,
          prop,
          "the side toggles must be compile-time booleans",
        );
        break;
      }
      case "final": {
        lowerer.noLowering(
          `the ${ctorName} option 'final'`,
          prop,
          ctorName === "Transform"
            ? "a user final on a Transform replaces the _flush composition — no lowering yet"
            : "the final callback is supported on Writable and Duplex",
        );
        break;
      }
      case "writev":
        lowerer.noLowering(
          `the ${ctorName} option 'writev'`,
          prop,
          "a Readable has no writable side",
        );
        break;
      default:
        lowerer.noLowering(`the ${ctorName} option '${name}'`, prop);
    }
  }
  // Canonical flag order = the accepted list's order. Options win over
  // overridden underscore methods (Node assigns options callbacks onto
  // the instance, shadowing the prototype method).
  for (let i = 0; i < accepted.length; i++) {
    const cb = present.get(accepted[i]!) ?? fallbackCb?.(accepted[i]!) ?? null;
    if (cb) {
      out.flags |= 1 << i;
      out.cbs.push(cb);
    }
  }
  for (const name of extraNames) {
    const cb = present.get(name) ?? fallbackCb?.(name) ?? null;
    if (cb) out.extras.push({ name, cb });
  }
  return out;
}

/** The head + flags argument list of a stream construction/initialization
 * (shared by `new Readable({...})` and a subclass's super(options)),
 * plus the parsed `encoding` option (applied as a follow-up setEncoding). */
function streamCtorArgs(
  lowerer: Lowerer,
  cls: string,
  arg: ts.Expression | undefined,
  thisType: IrType,
  loc: SrcLoc,
  fallbackCb?: (name: string) => IrExpr | null,
): {
  args: IrExpr[];
  encoding: string | null;
  badEncoding: string | null;
  pushEncoding: string | null;
  signal: IrExpr | null;
  valueDecls: IrStmt[];
  decodeStringsValue: IrExpr | null;
  defaultEncodingValue: IrExpr | null;
  readableObject: boolean;
  writableObject: boolean;
  decodeStringsOff: boolean;
  writeEncoding: string | null;
  extras: { name: string; cb: IrExpr }[];
} {
  const shape = streamCtorShape(cls);
  const o = parseStreamOptions(
    lowerer,
    cls.slice(1),
    arg,
    thisType,
    shape.accepted,
    loc,
    fallbackCb,
  );
  const head = shape.duplexShape
    ? [
        o.hwmR,
        o.hwmW,
        o.autoDestroy,
        o.emitClose,
        o.allowHalfOpen,
        boolLit(o.readableSide, loc),
        boolLit(o.writableSide, loc),
        numLit(o.flags, loc),
      ]
    : [cls === "%Writable" ? o.hwmW : o.hwmR, o.autoDestroy, o.emitClose, numLit(o.flags, loc)];
  return {
    args: [...head, ...o.cbs],
    encoding: o.encoding,
    badEncoding: o.badEncoding,
    pushEncoding: o.pushEncoding,
    signal: o.signal,
    valueDecls: o.valueDecls,
    decodeStringsValue: o.decodeStringsValue,
    defaultEncodingValue: o.defaultEncodingValue,
    readableObject: o.readableObject,
    writableObject: o.writableObject,
    decodeStringsOff: o.decodeStringsOff,
    writeEncoding: o.writeEncoding,
    extras: o.extras,
  };
}

/** The follow-ups a stream's options apply over the fresh stream `recv`
 * after the chained ones: decodeStrings, the writable defaultEncoding,
 * then writev and construct (Node's constructors schedule construct
 * last). */
function streamOptionFollowUps(
  parsed: {
    decodeStringsOff: boolean;
    writeEncoding: string | null;
    extras: { name: string; cb: IrExpr }[];
  },
  recv: () => IrExpr,
  thisType: IrType,
  loc: SrcLoc,
  writevFn: IrLibFn = "stream.setWritev",
): IrStmt[] {
  const out: IrStmt[] = [];
  if (parsed.decodeStringsOff) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "stream.decodeStrings",
        args: [recv(), boolLit(false, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  if (parsed.writeEncoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "writable.writeEncoding",
        args: [recv(), strLit(parsed.writeEncoding, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  for (const name of ["writev", "construct"]) {
    const extra = parsed.extras.find((x) => x.name === name);
    if (!extra) continue;
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: name === "writev" ? writevFn : "stream.setConstruct",
        args: [recv(), extra.cb],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return out;
}

/** `new Readable(opts?)` and friends — called from lowerNew once the
 * callee resolved to a builtin stream class. */
export function lowerStreamNew(lowerer: Lowerer, expr: ts.NewExpression, info: ClassInfo): IrExpr {
  const loc = locOf(expr);
  const cls = info.def.name;
  if (!RUNTIME_STREAM_CLASSES.has(cls)) lowerer.unsupported("SC1090", expr, `constructing ${cls}`);
  const thisType: IrType = { kind: "object", className: cls };
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 1) {
    lowerer.noLowering(
      `new ${info.def.name.slice(1)} with ${args.length} arguments`,
      expr,
      "the supported form takes one options object",
    );
  }
  if (args[0] !== undefined) {
    const dynOpts = dynOptionsValue(lowerer, args[0]);
    if (dynOpts !== null) {
      return {
        kind: "libCall",
        fn: `${streamCtorShape(cls).fn}.newDyn` as IrLibFn,
        args: [dynOpts],
        type: thisType,
        loc,
      };
    }
  }
  const fn = `${streamCtorShape(cls).fn}.new` as IrLibFn;
  const parsed = streamCtorArgs(lowerer, cls, args[0], thisType, loc);
  if (parsed.badEncoding !== null) {
    // Node's state constructors validate encodings first: an unknown
    // spelling never constructs — the whole expression throws.
    return nodeThrowExpr(
      1,
      "ERR_UNKNOWN_ENCODING",
      `Unknown encoding: ${parsed.badEncoding}`,
      thisType,
      loc,
    );
  }
  let built: IrExpr = { kind: "libCall", fn, args: parsed.args, type: thisType, loc };
  if (parsed.readableObject || parsed.writableObject) {
    // { objectMode }: applied before any other follow-up (answers the
    // receiver +1).
    built = {
      kind: "libCall",
      fn: "stream.objectMode",
      args: [built, boolLit(parsed.readableObject, loc), boolLit(parsed.writableObject, loc)],
      type: thisType,
      loc,
    };
  }
  const values = optionValuesArgs(parsed, loc);
  if (values) {
    // runtime decodeStrings and defaultEncoding values (answers the
    // receiver +1)
    built = {
      kind: "libCall",
      fn: "stream.optionValues",
      args: [built, ...values],
      type: thisType,
      loc,
    };
  }
  if (parsed.pushEncoding !== null) {
    // { defaultEncoding }: chain the push-side decode default (the
    // setEncoding chaining shape — answers the receiver +1).
    built = {
      kind: "libCall",
      fn: "readable.pushEncoding",
      args: [built, strLit(parsed.pushEncoding, loc)],
      type: thisType,
      loc,
    };
  }
  if (parsed.encoding !== null) {
    // { encoding }: chain a setEncoding over the fresh stream (the operand
    // temp releases with the frame; setEncoding answers the receiver +1).
    built = {
      kind: "libCall",
      fn: "readable.setEncoding",
      args: [built, strLit(parsed.encoding, loc)],
      type: thisType,
      loc,
    };
  }
  if (parsed.signal !== null) {
    // { signal }: addAbortSignal over the fresh stream (answers it +1).
    built = {
      kind: "libCall",
      fn: "stream.addAbortSignal",
      args: [built, parsed.signal],
      type: thisType,
      loc,
    };
  }
  if (!parsed.decodeStringsOff && parsed.writeEncoding === null && parsed.extras.length === 0) {
    return parsed.valueDecls.length > 0
      ? { kind: "seqExpr", stmts: parsed.valueDecls, result: built, type: thisType, loc }
      : built;
  }
  const fresh = lowerer.declareHiddenLocal("%stream", thisType);
  const followUps = streamOptionFollowUps(
    parsed,
    () => varRef(fresh.id, thisType, loc),
    thisType,
    loc,
  );
  return {
    kind: "seqExpr",
    stmts: [
      ...parsed.valueDecls,
      { kind: "varDecl", localId: fresh.id, init: built, loc },
      ...followUps,
    ],
    result: varRef(fresh.id, thisType, loc),
    type: thisType,
    loc,
  };
}

/** stream.optionValues' (decodeStrings, defaultEncoding) arguments, or
 * null when both options are literals or absent. */
function optionValuesArgs(
  parsed: { decodeStringsValue: IrExpr | null; defaultEncodingValue: IrExpr | null },
  loc: SrcLoc,
): IrExpr[] | null {
  if (parsed.decodeStringsValue === null && parsed.defaultEncodingValue === null) return null;
  return [
    parsed.decodeStringsValue ?? dynUndefinedExpr(loc),
    parsed.defaultEncodingValue ?? dynUndefinedExpr(loc),
  ];
}

/** True when a value of Node's argument type `passed` widens implicitly
 * into the declared parameter type `declared` (one of its union arms, or a
 * sub-union of it). */
function widensInto(lowerer: Lowerer, passed: IrType, declared: IrType, loc: SrcLoc): boolean {
  if (declared.kind !== "union") return false;
  const probe: IrExpr = { kind: "varRef", localId: "%probe", type: passed, loc };
  return typeEquals(lowerer.coerceToExpected(probe, declared).type, declared);
}

/* ── user subclasses (`extends Readable`, the underscore-override form) ── */

/** The wrapper closure binding one overridden underscore method as the
 * runtime's option callback: a lifted (this, ...prefix) function whose
 * body calls the method — through the vtable when some strict subclass
 * overrides it (the ordinary devirtualization rule), so an inherited
 * constructor still binds the DYNAMIC class's override. The method may
 * declare any PREFIX of its Node signature (the option-callback rule). */
function streamMethodWrapper(
  lowerer: Lowerer,
  info: ClassInfo,
  which: string,
  methodName: string,
  thisType: IrType,
  loc: SrcLoc,
  blame: ts.Node,
  chunkValues = true,
): IrExpr | null {
  const found = lowerer.findMethodOn(info, methodName);
  if (!found) {
    // A DESCENDANT-only declaration (the base chain never declares it):
    // this constructor cannot see it, and binding nothing without a
    // diagnostic would diverge from Node (which dispatches through the prototype chain).
    if (lowerer.overrideBelow(info, methodName)) {
      lowerer.noLowering(
        `a subclass of ${info.def.name.replace(/^%/, "")} declaring '${methodName}' below a base whose constructor cannot see it`,
        blame,
        `declare '${methodName}' on the class whose constructor calls the stream super(), and override it below`,
      );
    }
    return null;
  }
  // An ABSTRACT underscore declaration with no concrete override the
  // devirtualization can reach: no implementation exists to bind (the
  // class itself is abstract, so this constructor only ever runs under a
  // subclass — which, if concrete, implements the method and flips
  // overrideBelow into the virtual branch below).
  if (found.sig.abstract === true && !lowerer.overrideBelow(info, methodName)) {
    lowerer.noLowering(
      `an abstract '${methodName}' declaration with no concrete implementation below ${info.def.name.replace(/^%/, "")}`,
      blame,
      `implement '${methodName}' on a subclass the program constructs`,
    );
    return null;
  }
  const tuples = cbTuples(lowerer);
  const full = tuples[which]!;
  const declared = found.sig.params;
  if (declared.length > full.length) {
    lowerer.noLowering(
      `a '${methodName}' method declaring ${declared.length} parameters where Node passes ${full.length}`,
      blame,
      "stream underscore methods may declare a prefix of their Node signature",
    );
  }
  const paramTypes: IrType[] = [];
  for (let i = 0; i < declared.length; i++) {
    const want = full[i]!;
    const got = declared[i]!;
    if (got.mode !== "required") {
      lowerer.noLowering(
        `a '${methodName}' method with optional or defaulted parameters`,
        blame,
        "declare the Node signature's parameters plainly (any prefix is fine)",
      );
    }
    if (got.type.kind === "dyn") {
      // The JS lane's implicitly-any parameters: the emitted invoke
      // thunk boxes each position by kind.
    } else if (want === "fn") {
      if (got.type.kind !== "func") {
        lowerer.noLowering(
          `a '${methodName}' method whose parameter ${i} is '${lowerer.fmt(got.type)}' where Node passes the completion callback`,
          blame,
        );
      }
    } else if (!typeEquals(got.type, want)) {
      // A write or transform encoding of another type (`string | null |
      // undefined`) converts from the encoding argument's value: an
      // object-mode write passes undefined, null or the name. A chunk of
      // another type (`string | Buffer` under decodeStrings: false)
      // converts from the chunk's value.
      if (
        (i === 1 || (i === 0 && (chunkValues || which === "writev"))) &&
        (which === "write" || which === "transform" || which === "writev") &&
        got.type.kind !== "func" &&
        canConvertToDyn(
          got.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        paramTypes.push(got.type);
        continue;
      }
      // A declared supertype of what Node passes (`chunk: Buffer | string`)
      // is sound: the wrapper takes Node's value and widens it into the
      // declared parameter.
      if (widensInto(lowerer, want, got.type, loc)) {
        paramTypes.push(want);
        continue;
      }
      // A write or transform chunk of another type converts from the
      // chunk's value when the method runs (an object-mode side's value),
      // or throws a TypeError there; a byte-mode side's chunk is a Buffer.
      if (
        i === 0 &&
        (which === "writev" || (chunkValues && (which === "write" || which === "transform"))) &&
        got.type.kind !== "func" &&
        canConvertToDyn(
          got.type,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        paramTypes.push(got.type);
        continue;
      }
      lowerer.noLowering(
        `a '${methodName}' method whose parameter ${i} is '${lowerer.fmt(got.type)}' where Node passes '${lowerer.fmt(want)}'`,
        blame,
        "annotate the parameter with the Node signature's type or a supertype of it (chunks are Buffers here)",
      );
    }
    paramTypes.push(got.type);
  }
  const ret = found.sig.ret;
  const fnName = lowerer.closureName(loc, `_${which}vt`);
  const funcType = funcOf([thisType, ...paramTypes], ret);
  lowerer.fnStack.push(newFnCtx(true, null, funcType, ret));
  try {
    const thisLocal = lowerer.declareThis(thisType);
    const params = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const argRefs: IrExpr[] = [];
    for (let i = 0; i < paramTypes.length; i++) {
      const local = lowerer.declareHiddenLocal(`a${i}`, paramTypes[i]!);
      params.push({ localId: local.id, name: local.name, type: paramTypes[i]! });
      const arg: IrExpr = { kind: "varRef", localId: local.id, type: paramTypes[i]!, loc };
      const declaredType = declared[i]!.type;
      argRefs.push(
        typeEquals(arg.type, declaredType) ? arg : lowerer.coerceToExpected(arg, declaredType),
      );
    }
    const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisType, loc };
    let call: IrExpr;
    if (lowerer.overrideBelow(info, methodName)) {
      lowerer.noteVirtualEdge(info, methodName);
      call = {
        kind: "virtualCall",
        className: info.def.name,
        method: methodName,
        args: [thisRef, ...argRefs],
        type: ret,
        loc,
      };
    } else {
      lowerer.noteEdge(`%${found.declarer.def.name}.${methodName}`);
      call = {
        kind: "call",
        callee: `%${found.declarer.def.name}.${methodName}`,
        args: [lowerer.upcastTo(thisRef, found.declarer.def.name), ...argRefs],
        type: ret,
        loc,
      };
    }
    const body: IrStmt[] =
      ret.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc }]
        : [{ kind: "return", value: call, loc }];
    appendImplicitUndefinedReturn(lowerer, body, ret, loc);
    const ctx = lowerer.ctx;
    lowerer.liftedFns.push({
      name: fnName,
      params,
      returnType: ret,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    });
    return { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
  } finally {
    lowerer.fnStack.pop();
  }
}

/** `super(options?)` in a class whose direct base chain lands on a
 * runtime stream class: lowers to the stream.init libCall over `this`
 * (the emitted allocation already stamped the subclass vtable and
 * display name; the runtime builds the state block). Options parse
 * exactly like the construction form; overridden underscore methods on
 * the class chain fill callbacks the options leave unset. */
export function lowerStreamSuperCall(
  lowerer: Lowerer,
  info: ClassInfo,
  base: ClassInfo,
  argNodes: readonly ts.Expression[],
  thisLocal: { id: string },
  loc: SrcLoc,
  blame: ts.Node,
): IrStmt[] {
  const cls = base.def.name;
  const thisType: IrType = { kind: "object", className: info.def.name };
  if (argNodes.length > 1) {
    lowerer.noLowering(
      `super(...) with ${argNodes.length} arguments in a ${cls.slice(1)} subclass`,
      blame,
      "the supported form takes one inline options object (or none)",
    );
  }
  const shape = streamCtorShape(cls);
  // Whether the writable side holds values: options read at run time may
  // set objectMode, and a literal says so with objectMode (or a Duplex's
  // writableObjectMode) true; otherwise _write and _transform receive
  // Buffers.
  // super(undefined) and super(null) pass no options (followOptionsArg
  // answers null), so their sides are byte mode too.
  const optsNode = argNodes[0] !== undefined ? followOptionsArg(lowerer, argNodes[0]) : null;
  const chunkValues =
    optsNode !== null &&
    optsNode !== undefined &&
    (!ts.isObjectLiteralExpression(optsNode) ||
      literalWritesValues(optsNode, cls !== "%Readable" && cls !== "%Writable"));
  const fallback = (name: string): IrExpr | null => {
    const methodName = UNDERSCORE_METHODS.get(name) ?? STREAM_EXTRA_CALLBACKS.get(name);
    return methodName
      ? streamMethodWrapper(lowerer, info, name, methodName, thisType, loc, blame, chunkValues)
      : null;
  };
  const thisRef = (): IrExpr => ({ kind: "varRef", localId: thisLocal.id, type: thisType, loc });
  if (argNodes[0] !== undefined) {
    const dynOpts = dynOptionsValue(lowerer, argNodes[0]);
    if (dynOpts !== null) {
      // The dyn-options twin: the runtime walks the record; the class's
      // overridden underscore methods ride as FALLBACK wrappers (an
      // options callback shadows them, Node's instance-property rule).
      let flags = 0;
      const cbs: IrExpr[] = [];
      for (let i = 0; i < shape.accepted.length; i++) {
        const cb = fallback(shape.accepted[i]!);
        if (cb) {
          flags |= 1 << i;
          cbs.push(cb);
        }
      }
      // The class's _writev and _construct ride the same way: an options
      // writev or construct (applied by initDyn) wins.
      const extras: { name: string; cb: IrExpr }[] = [];
      for (const name of streamExtraCallbacks(cls)) {
        const cb = fallback(name);
        if (cb) extras.push({ name, cb });
      }
      return [
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: `${shape.fn}.initDyn` as IrLibFn,
            args: [thisRef(), dynOpts, numLit(flags, loc), ...cbs],
            type: VOID,
            loc,
          },
          loc,
        },
        ...streamOptionFollowUps(
          { decodeStringsOff: false, writeEncoding: null, extras },
          thisRef,
          thisType,
          loc,
          "stream.setWritevDefault",
        ),
      ];
    }
  }
  const parsed = streamCtorArgs(lowerer, cls, argNodes[0], thisType, loc, fallback);
  if (parsed.badEncoding !== null) {
    // super(options) with an unknown literal encoding: the state ctor
    // rejects before any initialization, Node's ladder.
    return [
      {
        kind: "exprStmt",
        expr: nodeThrowExpr(
          1,
          "ERR_UNKNOWN_ENCODING",
          `Unknown encoding: ${parsed.badEncoding}`,
          VOID,
          loc,
        ),
        loc,
      },
    ];
  }
  const out: IrStmt[] = [
    ...parsed.valueDecls,
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: `${shape.fn}.init` as IrLibFn,
        args: [thisRef(), ...parsed.args],
        type: VOID,
        loc,
      },
      loc,
    },
  ];
  if (parsed.readableObject || parsed.writableObject) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "stream.objectMode",
        args: [thisRef(), boolLit(parsed.readableObject, loc), boolLit(parsed.writableObject, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  const values = optionValuesArgs(parsed, loc);
  if (values) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "stream.optionValues",
        args: [thisRef(), ...values],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  if (parsed.pushEncoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "readable.pushEncoding",
        args: [thisRef(), strLit(parsed.pushEncoding, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  if (parsed.encoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "readable.setEncoding",
        args: [thisRef(), strLit(parsed.encoding, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  if (parsed.signal !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "stream.addAbortSignal",
        args: [thisRef(), parsed.signal],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  out.push(...streamOptionFollowUps(parsed, thisRef, thisType, loc));
  return out;
}

/* ── the underscore-method assignment surface ─────────────────────────── */

/** `r._read = fn` / `w._write = fn` (and _final/_destroy/_transform/
 * _flush) on a stream-rooted receiver AFTER construction — Node assigns
 * an own property that shadows the prototype method and the machinery
 * calls through it from then on. Here the runtime slot the option
 * callbacks fill swaps its closure: the RHS lowers exactly like the
 * matching option callback (inline functions fully static with the
 * stream as `this`; function VALUES — common.mustCall(fn) — through the
 * checked-dynamic boundary with the documented this-undefined
 * divergence), and the next _read/_write/... dispatch uses it, Node's
 * own timing. Null when the LHS is not an underscore-method write on a
 * runtime-stream-rooted receiver (the caller's routes continue);
 * `_writev` and methods outside the receiver's base set keep pointed
 * fences (Node would consume them through unlowered machinery). */
export function lowerStreamUnderscoreAssign(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrStmt | null {
  if (!ts.isPropertyAccessExpression(expr.left) || expr.left.questionDotToken) return null;
  const methodName = expr.left.name.text;
  if (!methodName.startsWith("_")) return null;
  const optionByMethod = new Map<string, string>();
  for (const [option, method] of UNDERSCORE_METHODS) optionByMethod.set(method, option);
  if (!optionByMethod.has(methodName) && methodName !== "_writev" && methodName !== "_construct")
    return null;
  const recv = tryLowerExpression(lowerer, expr.left.expression);
  if (!recv || recv.type.kind !== "object") return null;
  const info = lowerer.classes.get(recv.type.className);
  let base: ClassInfo | null = null;
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (RUNTIME_STREAM_CLASSES.has(c.def.name)) {
      base = c;
      break;
    }
  }
  if (!base) return null;
  const loc = locOf(expr);
  const cls = base.def.name;
  const clsName = cls.slice(1);
  // `_construct`: Node's constructNT reads it on the construction tick, so
  // an assignment before that tick replaces a scheduled hook
  // (stream.replaceConstruct) and has no effect after it or without one.
  const which =
    methodName === "_writev"
      ? "writev"
      : methodName === "_construct"
        ? "construct"
        : optionByMethod.get(methodName)!;
  const { accepted } = streamCtorShape(cls);
  if (!accepted.includes(which) && !streamExtraCallbacks(cls).includes(which)) {
    lowerer.noLowering(
      `assigning '${methodName}' on a ${clsName}`,
      expr.left,
      `a ${clsName}'s machinery consumes ${accepted.map((a) => `'${UNDERSCORE_METHODS.get(a)}'`).join("/")} — '${methodName}' would ride machinery with no lowering here`,
    );
  }
  const thisType: IrType = recv.type;
  const tuples = cbTuples(lowerer);
  let cb: IrExpr;
  const rhs = expr.right;
  if (ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs)) {
    const full = tuples[which]!.map((t) => (t === "fn" ? null : t));
    const { funcType } = lowerer.lambdaSignature(rhs);
    const tuple: IrType[] = full.map((t, i) => {
      if (t !== null) return t;
      const declared = funcType.params[i];
      if (declared !== undefined && declared.kind !== "func" && declared.kind !== "dyn") {
        lowerer.noLowering(
          `a '${methodName}' callback whose parameter ${i} is '${lowerer.fmt(declared)}' where Node passes the completion callback`,
          rhs,
        );
      }
      return declared ?? funcOf([], VOID);
    });
    cb = lowerStreamCallback(lowerer, which, rhs, thisType, tuple);
  } else {
    cb = lowerStreamCallbackValue(lowerer, clsName, which, rhs, tuples[which]!.length);
  }
  const SET_FNS: Record<string, IrLibFn> = {
    read: "stream.setRead",
    write: "stream.setWrite",
    final: "stream.setFinal",
    destroy: "stream.setDestroy",
    transform: "stream.setTransform",
    flush: "stream.setFlush",
    writev: "stream.setWritev",
    construct: "stream.replaceConstruct",
  };
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: SET_FNS[which]!, args: [recv, cb], type: VOID, loc },
    loc,
  };
}

/* ── the static surface (Readable.from) ───────────────────────────────── */

/** `Readable.from(iterable, options)`: string[] / Buffer[] sources
 * become a readable that pushes one element per _read (whole entries in
 * object mode, hwm 1), and a single string/Buffer argument is a
 * one-chunk stream (from.js's special case, the mode's default hwm). The
 * options lower when they are a literal of `objectMode` and
 * `highWaterMark`; the JS lane and `any` sources take the runtime's
 * checked-dynamic form. Called from the method-call chain once the
 * receiver resolved to a stream class value. */
export function lowerStreamStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  let symbol: ts.Symbol | null | undefined = null;
  if (ts.isIdentifier(access.expression)) {
    symbol = lowerer.resolveValueSymbol(access.expression);
  } else if (
    ts.isPropertyAccessExpression(access.expression) &&
    ts.isIdentifier(access.expression.name)
  ) {
    const memberSym = lowerer.checker.getSymbolAtLocation(access.expression.name);
    symbol =
      memberSym && memberSym.flags & ts.SymbolFlags.Alias
        ? lowerer.checker.getAliasedSymbol(memberSym)
        : memberSym;
  }
  if (!symbol) return null;
  const info = lowerer.builtinStreamInfoOf(symbol);
  if (!info) return null;
  const member = access.name.text;
  const loc = locOf(call);
  const cls = info.def.name;
  // Readable.toWeb's type-option ladder (JS sources): a provably-invalid
  // `type` throws Node's ERR_INVALID_ARG_VALUE before any web stream
  // exists; valid shapes keep the fence — the web bridge has no lowering.
  if (
    member === "toWeb" &&
    cls === "%Readable" &&
    call.arguments.nodes.length === 2 &&
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    ts.isObjectLiteralExpression(call.arguments.nodes[1]!)
  ) {
    for (const p of call.arguments.nodes[1]!.properties.nodes) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "type") {
        const t = lowerer.typeOf(p.initializer);
        if (t.isStringLiteralType() && t.value !== "bytes") {
          lowerer.lowerExpr(call.arguments.nodes[0]!); // evaluation order (the stream argument)
          return nodeThrowExpr(
            1,
            "ERR_INVALID_ARG_VALUE",
            `The property 'options.type' must be one of: 'bytes', undefined. Received '${t.value}'`,
            lowerer.mapTypeOf(lowerer.typeOf(call)) ?? DYN,
            loc,
          );
        }
      }
    }
  }
  if (member === "fromWeb" && cls === "%Readable") return lowerReadableFromWeb(lowerer, call, loc);
  if (member !== "from") {
    lowerer.noLowering(`${cls.slice(1)}.${member}`, call);
  }
  if (cls === "%Duplex") {
    const fromArgs = call.arguments.nodes;
    if (fromArgs.length !== 1) {
      lowerer.noLowering(
        `Duplex.from with ${fromArgs.length} arguments`,
        call,
        "Duplex.from takes one body",
      );
    }
    return duplexFromBody(lowerer, fromArgs[0]!, locOf(call));
  }
  if (cls !== "%Readable") {
    lowerer.noLowering(
      `${cls.slice(1)}.from`,
      call,
      "Readable.from and Duplex.from are the lowered forms",
    );
  }
  const args = call.arguments.nodes;
  if (args.length > 2) {
    lowerer.noLowering(
      `Readable.from with ${args.length} arguments`,
      call,
      "Readable.from(iterable, options) is the supported form",
    );
  }
  return lowerFromSource(lowerer, call, args[0], args[1], false);
}

/** Readable.fromWeb(readableStream, options): Node's adapter over the web
 * stream's reader (scr_stream_from_web.c). The options are an object
 * literal: objectMode a boolean literal, highWaterMark a number, encoding
 * a literal name, and signal a variable or property read, applied with
 * addAbortSignal as the constructors do. */
function lowerReadableFromWeb(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = call.arguments.nodes;
  const readable: IrType = { kind: "object", className: "%Readable" };
  if (args.length === 0 || args.length > 2 || args.some((a) => ts.isSpreadElement(a))) {
    lowerer.noLowering(
      `Readable.fromWeb with ${args.length} arguments`,
      call,
      "the supported form is Readable.fromWeb(readableStream, options)",
    );
  }
  const web = lowerer.lowerExprExpecting(args[0]!, DYN);
  let objectMode = false;
  let hwm: IrExpr = numLit(-1, loc);
  let encoding = "";
  let signal: IrExpr | null = null;
  const options = args[1];
  if (options !== undefined) {
    if (!ts.isObjectLiteralExpression(options)) {
      lowerer.noLowering(
        "Readable.fromWeb options that are not an object literal",
        options,
        "pass { objectMode, highWaterMark, encoding, signal } as an object literal",
      );
    }
    for (const p of options.properties.nodes) {
      const key =
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name)
          ? p.name.text
          : null;
      const value =
        key === null
          ? null
          : ts.isShorthandPropertyAssignment(p)
            ? (p.name as ts.Identifier)
            : (p as ts.PropertyAssignment).initializer;
      if (key === "objectMode" && value) {
        if (value.kind === ts.SyntaxKind.TrueKeyword) objectMode = true;
        else if (value.kind !== ts.SyntaxKind.FalseKeyword)
          lowerer.noLowering(
            "the Readable.fromWeb option 'objectMode' with this value",
            p,
            "write true or false",
          );
        continue;
      }
      if (key === "highWaterMark" && value) {
        hwm = lowerer.lowerExprExpecting(value, F64);
        continue;
      }
      if (key === "encoding" && value) {
        const t = lowerer.typeOf(value);
        if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
          return nodeThrowExpr(
            1,
            "ERR_INVALID_ARG_VALUE",
            `The property 'options.encoding' is invalid. Received '${t.value}'`,
            readable,
            loc,
          );
        }
        encoding = bufEncoding(lowerer, "the Readable.fromWeb option 'encoding'", value);
        continue;
      }
      if (key === "signal" && value) {
        if (!sideEffectFreeOptionValue(value) && !pureRead(value)) {
          lowerer.noLowering(
            "the Readable.fromWeb option 'signal' with this value",
            p,
            "pass a variable or property read (const signal = controller.signal)",
          );
        }
        signal = lowerer.lowerExprExpecting(value, DYN);
        continue;
      }
      lowerer.noLowering(
        key === null
          ? "Readable.fromWeb options with this member"
          : `the Readable.fromWeb option '${key}'`,
        p,
        "objectMode, highWaterMark, encoding and signal are the Readable.fromWeb options",
      );
    }
  }
  const built: IrExpr = {
    kind: "libCall",
    fn: "fetch.readableFromWeb",
    args: [web, boolLit(objectMode, loc), hwm, strLit(encoding, loc)],
    type: readable,
    loc,
  };
  if (signal === null) return built;
  return {
    kind: "libCall",
    fn: "stream.addAbortSignal",
    args: [built, signal],
    type: readable,
    loc,
  };
}

/** Readable.from(source, options), and for Duplex.from over an iterable
 * (duplex) duplexify.js's from(Duplexify, body, { objectMode: true,
 * writable: false }): the same builders with SCR_FROM_DUPLEX, answering a
 * Duplexify without a writable side. */
function lowerFromSource(
  lowerer: Lowerer,
  at: ts.Node,
  srcNode: ts.Expression | undefined,
  optsNode: ts.Expression | undefined,
  duplex: boolean,
): IrExpr {
  const loc = locOf(at);
  const call = at;
  const type: IrType = { kind: "object", className: duplex ? "%Duplex" : "%Readable" };
  const what = duplex ? "Duplex.from" : "Readable.from";
  // SCR_FROM_DUPLEX
  const duplexFlag = duplex ? 32 : 0;
  const js = isJsSourceFile(ts.getSourceFileOfNode(call));
  // A web ReadableStream is async iterable: from.js reads its iterator.
  // Duplex.from takes _duplexify({ readable: Readable.fromWeb(body) }).
  const webElem = srcNode ? staticReadableStreamElementType(lowerer, srcNode) : null;
  if (srcNode && webElem !== null && duplex) {
    const fromWeb: IrExpr = {
      kind: "libCall",
      fn: "fetch.readableFromWeb",
      args: [
        lowerer.lowerExprExpecting(srcNode, DYN),
        boolLit(false, loc),
        numLit(-1, loc),
        strLit("", loc),
      ],
      type: { kind: "object", className: "%Readable" },
      loc,
    };
    return { kind: "libCall", fn: "stream.duplexifyReadable", args: [fromWeb], type, loc };
  }
  if (srcNode && webElem !== null) {
    const source = lowerWebStreamSource(lowerer, srcNode, webElem, loc);
    const helpers = source ? fromGenHelpers(lowerer, source.out, loc) : null;
    const opts = optsNode ? fromOptions(lowerer, optsNode) : { flags: 0, hwm: null };
    if (!source || !helpers || !opts || !fromGenChunk(lowerer, webElem)) {
      lowerer.noLowering(
        `Readable.from over a web ReadableStream of '${lowerer.fmt(webElem)}'`,
        srcNode,
      );
    }
    const hwm = opts!.hwm ? lowerer.lowerExprExpecting(opts!.hwm, F64) : numLit(0, loc);
    const gen: IrExpr = {
      kind: "callValue",
      callee: source!.closure,
      args: [],
      type: source!.out,
      loc,
    };
    return {
      kind: "libCall",
      fn: "readable.fromAsyncGen",
      args: [gen, ...helpers!, numLit(opts!.flags, loc), hwm],
      type,
      loc,
    };
  }
  const srcT = srcNode ? lowerer.mapTypeOf(lowerer.typeOf(srcNode)) : null;
  const typedElem = (t: IrType | null | undefined): "string" | "bytes" | null =>
    t?.kind === "string" ? "string" : t?.kind === "bytes" && t.elem === "u8" ? "bytes" : null;
  const single = typedElem(srcT);
  const elem = srcT?.kind === "array" ? typedElem(srcT.elem) : null;
  const opts0 = optsNode ? fromOptions(lowerer, optsNode) : { flags: 0, hwm: null };
  const opts = opts0 ? { ...opts0, flags: opts0.flags | duplexFlag } : opts0;
  // A class whose [Symbol.iterator]() or [Symbol.asyncIterator]() is a
  // generator method: from.js calls the method when the stream is built,
  // then reads the generator like any other.
  const genMethod = srcT?.kind === "object" ? classGeneratorMethodOf(lowerer, srcT) : null;
  const genT = srcT?.kind === "generator" ? srcT : (genMethod?.gen ?? null);
  if (srcNode && genT && opts && fromGenChunk(lowerer, genT.yieldT)) {
    // A compiled generator: the runtime pulls it through interned helpers.
    const recv = lowerer.lowerExpr(srcNode);
    const gen =
      genMethod && srcT?.kind === "object"
        ? accessorCall(lowerer, srcT.className, genMethod.method, recv, [], genT, loc)
        : recv;
    const helpers = fromGenHelpers(lowerer, genT, loc);
    if (helpers) {
      const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
      return {
        kind: "libCall",
        fn: genT.async ? "readable.fromAsyncGen" : "readable.fromGen",
        args: [gen, ...helpers, numLit(opts.flags, loc), hwm],
        type,
        loc,
      };
    }
  }
  // from.js prefers Symbol.asyncIterator: a class declaring one takes the
  // async route.
  const asyncOpen =
    srcT?.kind === "object" &&
    lowerer.classes.has(srcT.className) &&
    lowerer.findMethodOn(lowerer.classes.get(srcT.className)!, "sym:asyncIterator") !== null;
  const cit = srcT?.kind === "object" && !asyncOpen ? classIteratorOf(lowerer, srcT) : null;
  if (srcNode && cit && opts && fromGenChunk(lowerer, cit.valueT)) {
    // A class iterable: from.js takes the iterator when the stream is
    // built (the typed [Symbol.iterator]() call here), and the runtime
    // pulls it through a checked-dynamic { next } object. Class iterators
    // declare no return() or throw(), so destroy calls neither.
    const recv = lowerer.lowerExpr(srcNode);
    const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
    return {
      kind: "libCall",
      fn: "readable.fromIter",
      args: [
        classIteratorObject(lowerer, cit, classIteratorOpenCall(lowerer, cit, recv, loc), loc),
        numLit(opts.flags, loc),
        hwm,
      ],
      type,
      loc,
    };
  }
  const acit = srcT?.kind === "object" && asyncOpen ? classAsyncIteratorOf(lowerer, srcT) : null;
  if (srcNode && acit && opts && fromGenChunk(lowerer, acit.valueT)) {
    const recv = lowerer.lowerExpr(srcNode);
    const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
    return {
      kind: "libCall",
      fn: "readable.fromAsyncIter",
      args: [classAsyncIteratorObject(lowerer, acit, recv, loc), numLit(opts.flags, loc), hwm],
      type,
      loc,
    };
  }
  if (srcNode && (single || elem) && opts) {
    const v = lowerer.lowerExpr(srcNode);
    const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
    const arr: IrExpr = single ? { kind: "arrayLit", elems: [v], type: arrayOf(v.type), loc } : v;
    // SCR_FROM_STRINGS 1, SCR_FROM_SINGLE 2 (scr_runtime.h); the options
    // add SCR_FROM_BYTE_MODE 4 and SCR_FROM_HAS_HWM 8.
    const flags = ((single ?? elem) === "string" ? 1 : 0) | (single ? 2 : 0) | opts.flags;
    return {
      kind: "libCall",
      fn: "readable.fromArr",
      args: [arr, numLit(flags, loc), hwm],
      type,
      loc,
    };
  }
  const anySrc =
    srcT?.kind === "dyn" ||
    // a Set or Map (entry arrays) of other values: the checked-dynamic
    // view iterates the collection itself
    ((srcT?.kind === "set" || srcT?.kind === "map") &&
      canConvertToDyn(
        srcT,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )) ||
    // an array of other values: the object-mode entries come from its
    // checked-dynamic copy
    (srcT?.kind === "array" && fromGenChunk(lowerer, srcT.elem) && typedElem(srcT.elem) === null) ||
    (srcNode !== undefined &&
      srcT === null &&
      (lowerer.typeOf(srcNode).flags & ts.TypeFlags.Any) !== 0);
  if (js || anySrc) {
    // The checked-dynamic form: the runtime takes from.js's ladder
    // (ERR_INVALID_ARG_TYPE for a non-iterable, the options, null values).
    const src = srcNode ? lowerer.lowerExprExpecting(srcNode, DYN) : dynUndefinedExpr(loc);
    if (duplex) return { kind: "libCall", fn: "stream.duplexFromDyn", args: [src], type, loc };
    const o = lowerOperatorValue(lowerer, optsNode, "Readable.from options", loc, true);
    return { kind: "libCall", fn: "readable.fromDyn", args: [src, o], type, loc };
  }
  if (srcNode && (single || elem)) {
    lowerer.noLowering(
      "Readable.from with these options",
      optsNode!,
      "an object literal with 'objectMode' (true or false) and a number 'highWaterMark' is supported",
    );
  }
  lowerer.noLowering(
    `${what} over a '${srcT ? lowerer.fmt(srcT) : "?"}' source`,
    srcNode ?? call,
    "the supported sources are a string or Buffer, and arrays, Sets, Maps, generators and class iterables of values that convert to checked-dynamic values",
  );
}

/** Whether a generator's yields can be stream chunks: values that box
 * into checked-dynamic values (null included: the runtime destroys the
 * stream with ERR_STREAM_NULL_VALUES). An object-mode stream takes any of
 * them; a byte-mode one checks them when they are pushed or written. */
function fromGenChunk(lowerer: Lowerer, t: IrType): boolean {
  if (t.kind === "nullT" || t.kind === "void" || t.kind === "func") return false;
  return (
    t.kind === "dyn" ||
    canConvertToDyn(
      t,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  );
}

/** The helpers Readable.from pulls a compiled generator through, as
 * closures in libcall order: a sync generator's next/return/throw answer
 * the next value as a checked-dynamic value or the done marker
 * (readable.fromDone); an async generator's next/return/throw answer the
 * resume's promise, followed by `read`, which maps its IteratorResult the
 * same way. Interned per generator type. Null when the result record has
 * no lowering. */
function fromGenHelpers(
  lowerer: Lowerer,
  gen: IrType & { kind: "generator" },
  loc: SrcLoc,
): IrExpr[] | null {
  const recT = genResultRecord(gen.yieldT, gen.retT, lowerer.shapes, lowerer.unions);
  const valueT =
    recT && lowerer.shapes.get(recT.shapeId)?.fields.find((f) => f.name === "value")?.type;
  if (!recT || !valueT) return null;
  const done = (): IrExpr => ({
    kind: "libCall",
    fn: "readable.fromDone",
    args: [],
    type: DYN,
    loc,
  });
  // `r.done ? done : r.value` over a record local.
  const readRecord = (localId: string): IrStmt[] | null => {
    const r = varRef(localId, recT, loc);
    const value = extractIteratorValue(
      lowerer,
      gen.yieldT,
      valueT,
      { kind: "recordGet", obj: r, shapeId: recT.shapeId, field: "value", type: valueT, loc },
      loc,
    );
    if (!value) return null;
    return [
      {
        kind: "if",
        cond: { kind: "recordGet", obj: r, shapeId: recT.shapeId, field: "done", type: BOOL, loc },
        then: [{ kind: "return", value: done(), loc }],
        else_: null,
        loc,
      },
      { kind: "return", value: lowerer.coerceToExpected(value, DYN), loc },
    ];
  };
  const promiseT: IrType = { kind: "promise", inner: recT };
  const define = (
    role: string,
    params: { id: string; type: IrType }[],
    returnType: IrType,
    body: IrStmt[],
    locals: { id: string; type: IrType }[] = [],
  ): IrExpr => {
    const key = `streamFromGen:${role}:${typeKey(gen)}`;
    let name = lowerer.valueHelpers.get(key);
    if (!name) {
      name = keyedHelperName(lowerer, `%stream.fromGen.${role}`, key);
      lowerer.valueHelpers.set(key, name);
      lowerer.liftedFns.push({
        name,
        params: params.map((p) => ({ localId: p.id, name: p.id.split(".")[0]!, type: p.type })),
        returnType,
        locals: [...params, ...locals].map((l) => ({
          id: l.id,
          name: l.id.split(".")[0]!,
          type: l.type,
          mutable: false,
        })),
        body,
        loc,
      });
    }
    return {
      kind: "closure",
      fnName: name,
      captures: [],
      type: funcOf(
        params.map((p) => p.type),
        returnType,
      ),
      loc,
    };
  };
  const g = { id: "gen.0", type: gen as IrType };
  const e = { id: "err.0", type: DYN };
  const r = { id: "res.0", type: recT as IrType };
  const genRef = varRef("gen.0", gen, loc) as IrExpr & { type: typeof gen };
  const resume = (mode: "next" | "return" | "throw"): IrExpr => ({
    kind: "genResume",
    mode,
    gen: genRef,
    arg: mode === "throw" ? varRef("err.0", DYN, loc) : null,
    type: gen.async ? promiseT : recT,
    loc,
  });
  const read = readRecord("res.0");
  if (!read) return null;
  if (gen.async) {
    const ret = (mode: "next" | "return" | "throw"): IrStmt[] => [
      { kind: "return", value: resume(mode), loc },
    ];
    return [
      define("anext", [g], promiseT, ret("next")),
      define("aread", [r], DYN, read),
      define("areturn", [g], promiseT, ret("return")),
      define("athrow", [g, e], promiseT, ret("throw")),
    ];
  }
  const viaRecord = (mode: "next" | "return" | "throw"): IrStmt[] => [
    { kind: "varDecl", localId: "res.0", init: resume(mode), loc },
    ...read,
  ];
  const next: IrStmt[] = stepDrivable(gen)
    ? [
        {
          kind: "if",
          cond: genStep(genRef, loc),
          then: [{ kind: "return", value: done(), loc }],
          else_: null,
          loc,
        },
        { kind: "return", value: lowerer.coerceToExpected(genValue(genRef, loc), DYN), loc },
      ]
    : viaRecord("next");
  const withRecord = stepDrivable(gen) ? [] : [r];
  return [
    define("next", [g], DYN, next, withRecord),
    define("return", [g], DYN, viaRecord("return"), [r]),
    define("throw", [g, e], DYN, viaRecord("throw"), [r]),
  ];
}

/** `{ next() { const r = it.next(); return { value: r.value, done: r.done }; } }`
 * over a class iterator `it`, as a checked-dynamic object: an interned
 * lifted function per iterator class takes the iterator and answers the
 * object, whose `next` closure captures it. */
function classIteratorObject(
  lowerer: Lowerer,
  cit: ClassIteratorInfo,
  iter: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const key = `streamFromIter:${cit.iterT.kind === "object" ? cit.iterT.className : typeKey(cit.iterT)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.fromIter", key);
    lowerer.valueHelpers.set(key, name);
    const nextName = `${name}.next`;
    const nextT = funcOf([], DYN);
    const it: IrLocal = { id: "it.0", name: "it", type: cit.iterT, mutable: false, boxed: true };
    const r: IrLocal = { id: "res.0", name: "res", type: cit.resultT, mutable: false };
    const field = (f: string, t: IrType): IrExpr => ({
      kind: "recordGet",
      obj: varRef(r.id, cit.resultT, loc),
      shapeId: cit.resultT.shapeId,
      field: f,
      type: t,
      loc,
    });
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    lowerer.liftedFns.push({
      name: nextName,
      params: [],
      returnType: DYN,
      captures: [{ localId: it.id, name: it.name, type: it.type }],
      locals: [it, r],
      body: [
        {
          kind: "varDecl",
          localId: r.id,
          init: classIteratorNextCall(lowerer, cit, varRef(it.id, cit.iterT, loc), null, loc),
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "dynObjLit",
            fields: [
              {
                key: str("value"),
                value: lowerer.coerceToExpected(field("value", cit.valueT), DYN),
              },
              {
                key: str("done"),
                value: {
                  kind: "dynFrom",
                  value: cit.hasDone ? field("done", BOOL) : boolLit(false, loc),
                  type: DYN,
                  loc,
                },
              },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: it.id, name: it.name, type: it.type }],
      returnType: DYN,
      locals: [it],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynObjLit",
            fields: [
              {
                key: str("next"),
                value: {
                  kind: "dynFrom",
                  value: { kind: "closure", fnName: nextName, captures: [it.id], type: nextT, loc },
                  type: DYN,
                  loc,
                },
              },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [iter], type: DYN, loc };
}

/** A class's zero-parameter `[Symbol.asyncIterator]()` (checked first, as
 * from.js does) or `[Symbol.iterator]()` method that returns a generator,
 * with its method slot. */
function classGeneratorMethodOf(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
): { method: string; gen: IrType & { kind: "generator" } } | null {
  const info = lowerer.classes.get(t.className);
  if (!info) return null;
  for (const method of ["sym:asyncIterator", "sym:iterator"]) {
    const m = lowerer.findMethodOn(info, method);
    if (!m) continue;
    const ret = m.sig.ret;
    if (m.sig.abstract === true || m.sig.params.length !== 0 || ret.kind !== "generator")
      return null;
    return { method, gen: ret };
  }
  return null;
}

/** An async class iterable's protocol, statically resolved: the receiver's
 * zero-parameter `[Symbol.asyncIterator]()` returns a class whose
 * `next()` returns a promise of a `{ value, done? }` record, and whose
 * optional `return()` does the same. */
interface ClassAsyncIteratorInfo {
  className: string;
  iterT: IrType & { kind: "object" };
  resultT: IrType & { kind: "record" };
  valueT: IrType;
  hasReturn: boolean;
}

function classAsyncIteratorOf(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
): ClassAsyncIteratorInfo | null {
  const info = lowerer.classes.get(t.className);
  const open = info ? lowerer.findMethodOn(info, "sym:asyncIterator") : null;
  if (!open || open.sig.abstract === true || open.sig.params.length !== 0) return null;
  const iterT = open.sig.ret;
  if (iterT.kind !== "object") return null;
  const itInfo = lowerer.classes.get(iterT.className);
  if (!itInfo || lowerer.findMethodOn(itInfo, "throw")) return null;
  const record = (name: string): (IrType & { kind: "record" }) | null => {
    const m = lowerer.findMethodOn(itInfo, name);
    if (!m || m.sig.abstract === true || m.sig.params.length !== 0) return null;
    const ret = m.sig.ret;
    return ret.kind === "promise" && ret.inner.kind === "record" ? ret.inner : null;
  };
  const resultT = record("next");
  if (!resultT) return null;
  const shape = lowerer.shapes.get(resultT.shapeId);
  const value = shape?.fields.find((f) => f.name === "value");
  const done = shape?.fields.find((f) => f.name === "done");
  if (!value || (done && done.type.kind !== "bool")) return null;
  const hasReturn = lowerer.findMethodOn(itInfo, "return") !== null;
  if (hasReturn && !record("return")) return null;
  return { className: t.className, iterT, resultT, valueT: value.type, hasReturn };
}

/** The checked-dynamic iterator object over an async class iterable:
 * `recv[Symbol.asyncIterator]()` runs when the stream is built, and the
 * object's `next` (and `return`, when the class declares one) answer the
 * iterator's own promises boxed. */
function classAsyncIteratorObject(
  lowerer: Lowerer,
  cit: ClassAsyncIteratorInfo,
  recv: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const key = `streamFromAsyncIter:${cit.className}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.fromAsyncIter", key);
    lowerer.valueHelpers.set(key, name);
    const it: IrLocal = { id: "it.0", name: "it", type: cit.iterT, mutable: false, boxed: true };
    const src: IrLocal = {
      id: "src.0",
      name: "src",
      type: { kind: "object", className: cit.className },
      mutable: false,
    };
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const method = (m: string): { key: IrExpr; value: IrExpr } => {
      const fnName = `${name}.${m}`;
      const call = accessorCall(
        lowerer,
        cit.iterT.className,
        m,
        varRef(it.id, cit.iterT, loc),
        [],
        { kind: "promise", inner: cit.resultT },
        loc,
      );
      lowerer.liftedFns.push({
        name: fnName,
        params: [],
        returnType: DYN,
        captures: [{ localId: it.id, name: it.name, type: it.type }],
        locals: [it],
        body: [{ kind: "return", value: { kind: "dynFrom", value: call, type: DYN, loc }, loc }],
        loc,
      });
      return {
        key: str(m),
        value: {
          kind: "dynFrom",
          value: { kind: "closure", fnName, captures: [it.id], type: funcOf([], DYN), loc },
          type: DYN,
          loc,
        },
      };
    };
    const fields = [method("next"), ...(cit.hasReturn ? [method("return")] : [])];
    lowerer.liftedFns.push({
      name,
      params: [{ localId: src.id, name: src.name, type: src.type }],
      returnType: DYN,
      locals: [src, it],
      body: [
        {
          kind: "varDecl",
          localId: it.id,
          init: accessorCall(
            lowerer,
            cit.className,
            "sym:asyncIterator",
            varRef(src.id, src.type, loc),
            [],
            cit.iterT,
            loc,
          ),
          loc,
        },
        { kind: "return", value: { kind: "dynObjLit", fields, type: DYN, loc }, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [recv], type: DYN, loc };
}

/** Readable.from's typed options: an object literal of `objectMode`
 * (a boolean literal) and `highWaterMark` (a number), as SCR_FROM_* flag
 * bits and the hwm expression; null for any other shape. */
function fromOptions(
  lowerer: Lowerer,
  node: ts.Expression,
): { flags: number; hwm: ts.Expression | null } | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  let flags = 0;
  let hwm: ts.Expression | null = null;
  for (const prop of node.properties.nodes) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      return null;
    }
    const value = prop.initializer;
    if (prop.name.text === "objectMode") {
      if (value.kind === ts.SyntaxKind.FalseKeyword) flags |= 4;
      else if (value.kind === ts.SyntaxKind.TrueKeyword) flags &= ~4;
      else return null;
    } else if (prop.name.text === "highWaterMark") {
      if (lowerer.mapTypeOf(lowerer.typeOf(value))?.kind !== "f64") return null;
      flags |= 8;
      hwm = value;
    } else {
      return null;
    }
  }
  return { flags, hwm };
}

/** `const Writable = stream.Writable` — a runtime stream CLASS bound
 * through a namespace member: alias plumbing with no storage (both
 * declaration walks skip it; uses resolve through builtinStreamInfoOf's
 * alias following). Only the five stream class names count — value
 * members (stream.getDefaultHighWaterMark as a value, ...) keep their
 * per-site fences. */
export function streamClassAliasDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isIdentifier(nameNode) || !init) return false;
  if (!ts.isPropertyAccessExpression(init) || init.questionDotToken) return false;
  let isStreamClass = false;
  for (const [, rec] of RUNTIME_STREAM_CLASSES) {
    if (rec.lib === init.name.text) isStreamClass = true;
  }
  if (!isStreamClass) return false;
  return lowerer.builtinNamespaceModuleOf(init.expression) === "stream";
}

/* ── the module functions (finished / pipeline — the callback forms) ──── */

/** Node's pipeline stage ladder text (lib/internal/streams/pipeline.js's
 * makeAsyncIterable — every stage position renders the same "body"
 * clause). finished() keeps its narrower isNodeStream wording. */
const PIPELINE_STAGE_EXPECTED =
  "of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair";

/** A checked-dynamic pipeline stage taken as a stream: a boxed native
 * stream unwraps at run time, and a value that is not stream-like or a
 * function (an iterable after the first stage) becomes Duplex.from of it,
 * as pipelineImpl's last branch does. Stream-like objects, web streams and
 * { readable, writable } pairs throw the not-supported Error there, and so
 * do functions, which reach this lowering only past
 * MAX_DYN_FUNCTION_STAGES. */
function unboxDynStage(lowerer: Lowerer, v: IrExpr, node: ts.Expression): IrExpr {
  noteUntypedStreamFlow(lowerer, null);
  return {
    kind: "libCall",
    fn: "stream.unboxDynStage",
    args: [
      v,
      strLit(
        lowerer.dynNodeStreams
          ? "pipeline stages other than native streams, iterables and functions (JavaScript stream objects, web streams, { readable, writable } pairs after the first stage, and functions after the first three untyped stages) are not supported yet"
          : "pipeline stages other than native streams, iterables and functions (web streams, { readable, writable } pairs after the first stage, and functions after the first three untyped stages) are not supported yet",
        locOf(node),
      ),
    ],
    type: { kind: "object", className: "%Duplex" },
    loc: locOf(node),
  };
}

/** A pipeline whose first stage is checked-dynamic, lowered with that
 * stage already evaluated: `expr` is the stream it unboxes to, or, when
 * `iterable` is set, the value to pump as an iterable source. */
interface DynPipelineSource {
  expr: IrExpr;
  iterable: boolean;
}

/** pipeline() whose first stage is a stream argument (not a function
 * stage, an iterable of a static type, or a cipher value), lowered here.
 * When the value is checked-dynamic, Node keeps a stream there and pipes
 * it, and keeps an iterable (a string, an array, a generator, any value
 * with an iterator method) and pumps it into the next stage. The value is
 * evaluated once, and stream.dynIterableSource picks the lowering at run
 * time. Null when the first stage is not such an argument. */
function lowerDynSourcePipeline(
  lowerer: Lowerer,
  node: ts.Expression,
  loc: SrcLoc,
  build: (source: DynPipelineSource) => IrExpr,
): IrExpr | null {
  if (pipelineStageFunction(lowerer, node) !== null) return null;
  if (iterableSourceType(lowerer, node) !== null || isValueStream(lowerer, node)) return null;
  let value = lowerer.lowerExpr(node);
  // A Set, a Map or a generator object is iterated through its
  // checked-dynamic value.
  if (BOXED_SOURCE_KINDS.has(value.type.kind) && lowerer.dynConvertible(value.type)) {
    value = { kind: "dynFrom", value, type: DYN, loc: value.loc };
  }
  if (value.type.kind !== "dyn") {
    let stream: IrExpr;
    try {
      stream = streamArgOf(lowerer, node, value, "pipeline");
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    return build({ expr: stream, iterable: false });
  }
  const local = lowerer.declareHiddenLocal("%pipelineSource", DYN);
  const ref = varRef(local.id, DYN, loc);
  const stream = build({ expr: unboxDynStage(lowerer, ref, node), iterable: false });
  const iterable = build({ expr: ref, iterable: true });
  const type = stream.type;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: local.id, init: value, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "libCall", fn: "stream.dynIterableSource", args: [ref], type: BOOL, loc },
      then: lowerer.coerceToExpected(iterable, type),
      else_: stream,
      type,
      loc,
    },
    type,
    loc,
  };
}

/** The static types of a pipeline source that lowerDynSourcePipeline boxes
 * as checked-dynamic values. An array or a string reaches it when the
 * checker types the argument as any while its value keeps a static type. */
const BOXED_SOURCE_KINDS: ReadonlySet<IrType["kind"]> = new Set([
  "set",
  "map",
  "generator",
  "array",
  "string",
]);

/** The most checked-dynamic stages after the first that a pipeline
 * branches on as functions; each one doubles the lowered pipeline calls. */
const MAX_DYN_FUNCTION_STAGES = 3;

/** A pipeline's arguments for one of the run-time branches
 * lowerDynStagePipeline lowers. */
interface DynStagePlan {
  /** the first stage when it is checked-dynamic */
  source: DynPipelineSource | null;
  /** argument values evaluated before the branches, in argument order */
  bound: ReadonlyMap<number, IrExpr>;
  /** a typed iterable first stage's source, lowered before the branches */
  preSource?: { closure: IrExpr; out: SyncGenType } | undefined;
  /** the checked-dynamic stages this branch takes as functions */
  fns: ReadonlySet<number>;
}

/** pipeline() whose stages after the first include untyped values:
 * pipelineImpl calls a stage that is a function with the previous stage
 * and { signal }, and pipes into or takes any other value, so the call is
 * lowered once per combination of those stages being functions or not,
 * up to MAX_DYN_FUNCTION_STAGES of them, and a typeof test on each
 * picks the branch at run time. The arguments other than function stages
 * are evaluated first, in argument order. */
function lowerDynStagePipeline(
  lowerer: Lowerer,
  stageArgs: readonly ts.Expression[],
  src: DynPipelineSource | null,
  loc: SrcLoc,
  build: (plan: DynStagePlan) => IrExpr,
): IrExpr {
  const candidates: number[] = [];
  for (let j = 1; j < stageArgs.length; j++) {
    const arg = stageArgs[j]!;
    if (pipelineStageFunction(lowerer, arg) !== null || isValueStream(lowerer, arg)) continue;
    if ((lowerer.typeOf(arg).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      candidates.push(j);
    }
  }
  if (candidates.length === 0) return build({ source: src, bound: new Map(), fns: new Set() });
  const stmts: IrStmt[] = [];
  const bind = (init: IrExpr): IrExpr => {
    const local = lowerer.declareHiddenLocal("%pipelineArg", init.type);
    stmts.push({ kind: "varDecl", localId: local.id, init, loc: init.loc });
    return varRef(local.id, init.type, init.loc);
  };
  const source = src !== null && !src.iterable ? { expr: bind(src.expr), iterable: false } : src;
  const bound = new Map<number, IrExpr>();
  let preSource: DynStagePlan["preSource"];
  for (let j = src !== null ? 1 : 0; j < stageArgs.length; j++) {
    const arg = stageArgs[j]!;
    if (pipelineStageFunction(lowerer, arg) !== null) continue;
    if (j === 0 && iterableSourceType(lowerer, arg) !== null) {
      const lowered = lowerIterableSource(lowerer, arg, null, loc);
      if (lowered === null) lowerer.noLowering("pipeline over this source", arg);
      preSource = { closure: bind(lowered!.closure), out: lowered!.out };
      continue;
    }
    let value = lowerer.lowerExpr(arg);
    // an untyped array, string, Set, Map or generator object that keeps
    // its static type is taken through its checked-dynamic value
    if (
      candidates.includes(j) &&
      BOXED_SOURCE_KINDS.has(value.type.kind) &&
      lowerer.dynConvertible(value.type)
    ) {
      value = { kind: "dynFrom", value, type: DYN, loc: value.loc };
    }
    bound.set(j, bind(value));
  }
  const dynStages = candidates
    .filter((j) => bound.get(j)!.type.kind === "dyn")
    .slice(0, MAX_DYN_FUNCTION_STAGES);
  const branch = (i: number, fns: ReadonlySet<number>): IrExpr => {
    if (i === dynStages.length) return build({ source, bound, preSource, fns });
    const j = dynStages[i]!;
    const asStream = branch(i + 1, fns);
    const asFunction = branch(i + 1, new Set([...fns, j]));
    // a function destination's promise resolves to its value
    const type =
      asFunction.type.kind === "promise" && asFunction.type.inner.kind === "dyn"
        ? asFunction.type
        : asStream.type;
    return {
      kind: "ternary",
      cond: { kind: "dynTest", test: "function", value: bound.get(j)!, type: BOOL, loc },
      then: lowerer.coerceToExpected(asFunction, type),
      else_: lowerer.coerceToExpected(asStream, type),
      type,
      loc,
    };
  };
  const result = branch(0, new Set());
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** lowerPipelineStages' source arguments for a checked-dynamic first stage. */
function stagesSource(
  src: DynPipelineSource | null,
): [ReadonlyMap<number, IrExpr> | undefined, IrExpr | undefined] {
  if (src === null) return [undefined, undefined];
  return src.iterable ? [undefined, src.expr] : [new Map([[0, src.expr]]), undefined];
}

/** A pipeline stage taken as a stream under a DynStagePlan: the
 * checked-dynamic first stage's stream, a value bound before the
 * branches, or the argument lowered here. */
function planStreamArg(
  lowerer: Lowerer,
  plan: DynStagePlan,
  node: ts.Expression,
  i: number,
): IrExpr {
  if (i === 0 && plan.source !== null) return plan.source.expr;
  const bound = plan.bound.get(i);
  return bound !== undefined
    ? streamArgOf(lowerer, node, bound, "pipeline")
    : lowerStreamArg(lowerer, node, "pipeline");
}

/** A stream-rooted argument, lowered — or the pointed fence (pipeline's
 * iterable/generator/function stages have no lowering yet). `what` picks
 * the validation ladder: finished() rejects EVERY non-stream through
 * isNodeStream, while pipeline() accepts iterables (strings, arrays) and
 * { readable, writable } pairs — those shapes fence instead of throwing
 * a ladder Node never throws. */
function lowerStreamArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: "finished" | "pipeline" | "addAbortSignal" | "compose",
): IrExpr {
  return streamArgOf(lowerer, node, lowerer.lowerExpr(node), what);
}

/** lowerStreamArg over the argument's lowered value. */
function streamArgOf(
  lowerer: Lowerer,
  node: ts.Expression,
  lowered: IrExpr,
  what: "finished" | "pipeline" | "addAbortSignal" | "compose",
): IrExpr {
  // A Hash, Hmac, Cipheriv or Decipheriv stage is its Transform; pipeline
  // and compose stages keep the value alive until the stream settles.
  const v = isValueStream(lowerer, node)
    ? valueStreamOf(lowered, what === "pipeline" || what === "compose")
    : lowered;
  // A checked-dynamic pipeline stage (an untyped source or destination):
  // a boxed native stream unwraps at run time; other values (iterables,
  // functions) throw the not-supported Error there.
  if (v.type.kind === "dyn" && what === "pipeline") return unboxDynStage(lowerer, v, node);
  const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
  if (!streamSidesOf(lowerer, info)) {
    // A provably-non-stream value in a JS source (the invalid-input
    // probes: finished({}, cb), pipeline(42, dst, cb)): Node's gate
    // throws ERR_INVALID_ARG_TYPE before any watcher exists.
    const argTypeThrow = (argName: string, expected: string): never => {
      throw new StreamArgTypeThrow({
        kind: "libCall",
        fn: "error.argTypeThrow",
        args: [
          { kind: "strLit", value: argName, type: STRING, loc: locOf(node) },
          { kind: "strLit", value: expected, type: STRING, loc: locOf(node) },
          { kind: "dynFrom", value: v, type: DYN, loc: locOf(node) },
        ],
        type: VOID,
        loc: locOf(node),
      });
    };
    if (isJsSourceFile(ts.getSourceFileOfNode(node)) && lowerer.dynConvertible(v.type)) {
      if (what === "pipeline") {
        // Strings and arrays are iterables — VALID pipeline stages in
        // Node — and a record carrying a readable/writable member may be
        // the duplex-pair form; none of those shapes has a lowering, so
        // they take the pointed fence below, never a throw.
        const pairish =
          v.type.kind === "record" &&
          (lowerer.shapes.get(v.type.shapeId)?.fields ?? []).some(
            (f) => f.name === "readable" || f.name === "writable",
          );
        if (
          (v.type.kind === "record" && !pairish) ||
          v.type.kind === "f64" ||
          v.type.kind === "bool" ||
          v.type.kind === "nullT"
        ) {
          argTypeThrow("body", PIPELINE_STAGE_EXPECTED);
        }
      } else if (
        (ts.isObjectLiteralExpression(node) && node.properties.nodes.length === 0) ||
        v.type.kind === "record" ||
        v.type.kind === "string" ||
        v.type.kind === "f64" ||
        v.type.kind === "bool" ||
        v.type.kind === "array" ||
        v.type.kind === "nullT"
      ) {
        argTypeThrow("stream", "an instance of ReadableStream, WritableStream, or Stream");
      }
    }
    lowerer.noLowering(
      `${what} over a '${lowerer.fmt(v.type)}'`,
      node,
      what === "pipeline" || what === "compose"
        ? "stream stages are the lowered surface — Node also accepts iterables (strings, arrays), generators, plain functions, and { readable, writable } pairs, but those have no lowering yet"
        : "stream arguments are the lowered surface (iterables, generators, and plain functions have no lowering yet)",
    );
  }
  return v;
}

/** The always-throw replacement lowerStreamArg surfaces when the stream
 * slot holds a provably-non-stream value — the CALL's lowering catches it
 * and answers the throw as the whole call's value (Node throws before
 * registering anything, so the other arguments never evaluate their
 * effects; listener arguments are effect-free in practice). */
class StreamArgTypeThrow extends Error {
  constructor(readonly expr: IrExpr) {
    super("stream argument is not a stream");
  }
}

/** Whether a checked-dynamic pipeline callback can take undefined as its
 * error: a callback that is already checked-dynamic, one without
 * parameters, and one whose first parameter (or rest element) type holds
 * undefined. */
function callbackErrorAdmitsUndefined(lowerer: Lowerer, cb: IrExpr): boolean {
  if (cb.kind !== "dynFrom" || cb.value.type.kind !== "func") return true;
  const fnT = cb.value.type;
  const first = fnT.params[0];
  if (first === undefined) return true;
  const p0 =
    fnT.rest === true && fnT.params.length === 1 && first.kind === "array" ? first.elem : first;
  if (p0.kind === "dyn" || p0.kind === "jsval" || p0.kind === "undefinedT") return true;
  if (p0.kind !== "union") return false;
  return lowerer.unions.get(p0.unionId)?.arms.some((a) => a.kind === "undefinedT") ?? false;
}

/** The finished/pipeline completion callback: an inline function lowers
 * through the option-callback machinery (leading `this`, an `Error |
 * null` prefix — Node binds the stream and passes the error); any other
 * value adapts through the checked-dynamic boundary (mustCall wrappers —
 * the runtime inv calls it with NO arguments on success, Node's eos
 * convention). */
function lowerEosCallback(
  lowerer: Lowerer,
  which: string,
  node: ts.Expression,
  thisType: IrType,
): { cb: IrExpr; dyn: boolean } {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // The error parameter takes what the user declared when it is an
    // Error/null/undefined union (@types spells `ErrnoException | null |
    // undefined`); the emitted thunk picks the undefined arm on success.
    let tuple: IrType[] = [errorOrNull(lowerer)];
    try {
      const { funcType } = lowerer.lambdaSignature(node);
      const p0 = funcType.params[0];
      if (p0?.kind === "union") {
        const def = lowerer.unions.get(p0.unionId);
        if (
          def &&
          def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
          def.arms.every(
            (a) =>
              a.kind === "nullT" ||
              a.kind === "undefinedT" ||
              (a.kind === "object" && a.className === "%Error"),
          )
        ) {
          tuple = [p0];
        }
      }
    } catch {
      /* the fixed tuple speaks */
    }
    return { cb: lowerStreamCallback(lowerer, which, node, thisType, tuple), dyn: false };
  }
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(node);
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, node, ct);
  } catch {
    t = null;
  }
  if (t?.kind === "dyn") {
    const v = lowerer.lowerExpr(node);
    if (v.type.kind === "dyn") return { cb: v, dyn: true };
  } else if (t?.kind === "func") {
    const cb = lowerer.lowerExpr(node);
    if (cb.type.kind === "dyn") return { cb, dyn: true };
    if (cb.type.kind === "func" && canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      return { cb: { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) }, dyn: true };
    }
  }
  lowerer.noLowering(
    `${which} with this callback value`,
    node,
    "write the callback inline, or pass a function value that crosses the checked-dynamic boundary",
  );
}

/** finished()'s options literal: readable/writable/error (and cleanup
 * for the promise form) as boolean literals, signal as any expression.
 * readable/writable answer -1 when absent (Node's default: whether the
 * stream has that side). */
function eosOptions(
  lowerer: Lowerer,
  node: ts.Expression,
  promiseForm: boolean,
): { readable: number; writable: number; error: boolean; cleanup: boolean; signal: IrExpr | null } {
  const out = {
    readable: -1,
    writable: -1,
    error: true,
    cleanup: false,
    signal: null as IrExpr | null,
  };
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      "finished options that are not an object literal",
      node,
      "write the options inline: finished(stream, { readable, writable, error, signal })",
    );
  }
  const literal = (p: ts.PropertyAssignment, key: string): boolean => {
    if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    lowerer.noLowering(
      `the finished option '${key}' with a non-literal value`,
      p.initializer,
      "pass true or false",
    );
  };
  for (const p of node.properties.nodes) {
    const key =
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)
        ? p.name.text
        : null;
    if (key === "signal") {
      out.signal = ts.isShorthandPropertyAssignment(p)
        ? lowerer.lowerExprExpecting(p.name as ts.Identifier, DYN)
        : lowerer.lowerExprExpecting((p as ts.PropertyAssignment).initializer, DYN);
      continue;
    }
    if (key !== null && ts.isPropertyAssignment(p)) {
      if (key === "readable") out.readable = literal(p, key) ? 1 : 0;
      else if (key === "writable") out.writable = literal(p, key) ? 1 : 0;
      else if (key === "error") out.error = literal(p, key);
      else if (key === "cleanup" && promiseForm) out.cleanup = literal(p, key);
      else {
        lowerer.noLowering(
          `the finished option '${key}'`,
          p,
          promiseForm
            ? "readable, writable, error, cleanup and signal are the supported options"
            : "readable, writable, error and signal are the supported options",
        );
      }
      continue;
    }
    lowerer.noLowering(
      "finished options with this member",
      p,
      "write each option as a plain property",
    );
  }
  return out;
}

/** pipeline()'s trailing options literal (the promise form): signal as
 * any expression, end as a boolean literal. */
function pipelineOptions(
  lowerer: Lowerer,
  node: ts.ObjectLiteralExpression,
): { end: boolean; signal: IrExpr | null } {
  const out = { end: true, signal: null as IrExpr | null };
  for (const p of node.properties.nodes) {
    const key =
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)
        ? p.name.text
        : null;
    if (key === "signal") {
      out.signal = ts.isShorthandPropertyAssignment(p)
        ? lowerer.lowerExprExpecting(p.name as ts.Identifier, DYN)
        : lowerer.lowerExprExpecting((p as ts.PropertyAssignment).initializer, DYN);
      continue;
    }
    if (key === "end" && ts.isPropertyAssignment(p)) {
      if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) continue;
      if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        out.end = false;
        continue;
      }
      lowerer.noLowering(
        "the pipeline option 'end' with a non-literal value",
        p.initializer,
        "pass true or false",
      );
    }
    lowerer.noLowering(
      key === null ? "pipeline options with this member" : `the pipeline option '${key}'`,
      p,
      "signal and end are the supported pipeline options",
    );
  }
  return out;
}

/** `finished(...)` / `pipeline(...)` / `getDefaultHighWaterMark(...)`
 * imported from node:stream (named imports, destructured requires, and
 * namespace-member calls all land here). Null for members this spoke
 * does not own — the caller's module-qualified fence speaks. */
export function lowerStreamModuleCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module === "stream/promises") {
    const args = call.arguments.nodes;
    // finished(stream) → a pending void promise the terminal watcher
    // settles (rejected with the stream's error, or
    // ERR_STREAM_PREMATURE_CLOSE — the callback form's status, boxed
    // through the promise instead). The options argument has no lowering.
    if (bi.member === "finished") {
      if (args.length !== 1 && args.length !== 2) {
        lowerer.noLowering(
          `stream/promises.finished with ${args.length} arguments`,
          call,
          "the supported forms are finished(stream) and finished(stream, options)",
        );
      }
      let recv: IrExpr;
      try {
        recv = lowerStreamArg(lowerer, args[0]!, "finished");
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) return e.expr;
        throw e;
      }
      const optsNode = args[1];
      if (optsNode !== undefined && optsNode.kind !== ts.SyntaxKind.NullKeyword) {
        const o = eosOptions(lowerer, optsNode, true);
        const head: IrExpr[] = [
          recv,
          numLit(o.readable, loc),
          numLit(o.writable, loc),
          boolLit(o.error, loc),
          boolLit(o.cleanup, loc),
        ];
        return {
          kind: "libCall",
          fn: o.signal ? "sp.finishedOptsSignal" : "sp.finishedOpts",
          args: o.signal ? [...head, o.signal] : head,
          type: { kind: "promise", inner: VOID },
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "sp.finished",
        args: [recv],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    // pipeline(...streams) → the callback pipeline's chaining/destroyer
    // semantics with the settlement on a promise. Stream stages only
    // (lowerStreamArg's fence); Node's promise resolves undefined for
    // stream destinations, so the result is a void promise.
    if (bi.member === "pipeline") {
      if (args.length < 2) {
        lowerer.noLowering(
          `stream/promises.pipeline with ${args.length} arguments`,
          call,
          "the supported form is pipeline(source, ...streams)",
        );
      }
      const lastArg = args[args.length - 1]!;
      const opts =
        ts.isObjectLiteralExpression(lastArg) && args.length >= 3
          ? pipelineOptions(lowerer, lastArg)
          : null;
      const stageArgs = opts ? args.slice(0, -1) : args;
      const build = (src: DynPipelineSource | null): IrExpr =>
        lowerDynStagePipeline(lowerer, stageArgs, src, loc, (plan) =>
          lowerPromisePipeline(lowerer, stageArgs, opts, plan, loc),
        );
      return lowerDynSourcePipeline(lowerer, stageArgs[0]!, loc, build) ?? build(null);
    }
    return null;
  }
  return lowerStreamModuleCallbackCall(lowerer, call, bi, loc);
}

/** stream/promises pipeline(...stages[, options]), for one branch of
 * lowerDynStagePipeline's plan. */
function lowerPromisePipeline(
  lowerer: Lowerer,
  stageArgs: readonly ts.Expression[],
  opts: ReturnType<typeof pipelineOptions> | null,
  plan: DynStagePlan,
  loc: SrcLoc,
): IrExpr {
  const src = plan.source;
  if (
    src?.iterable === true ||
    plan.fns.size > 0 ||
    plan.preSource !== undefined ||
    hasPipelineFunctionStage(lowerer, stageArgs)
  ) {
    const staged = lowerPipelineStages(lowerer, stageArgs, loc, ...stagesSource(src), plan);
    const type = staged.destPromise ?? { kind: "promise", inner: VOID };
    // A promise destination's value settles the result (same type).
    if (!opts) {
      return staged.wrap({
        kind: "libCall",
        fn: "sp.pipelineStages",
        args: staged.args,
        type,
        loc,
      });
    }
    // the options: end, and the signal (flags bit 6)
    const flagsArg = staged.args[3]!;
    if (flagsArg.kind !== "numLit") throw new InternalCompilerError("pipeline flags not a literal");
    const args = [...staged.args, boolLit(opts.end, loc)];
    if (opts.signal) {
      args[3] = numLit(flagsArg.value | 64, loc);
      args.push(opts.signal);
    }
    return staged.wrap({ kind: "libCall", fn: "sp.pipelineStagesOpts", args, type, loc });
  }
  let streams: IrExpr[];
  try {
    streams = stageArgs.map((a, i) => planStreamArg(lowerer, plan, a, i));
  } catch (e) {
    if (e instanceof StreamArgTypeThrow) return e.expr;
    throw e;
  }
  if (opts) {
    const head = [numLit(streams.length, loc), ...streams, boolLit(opts.end, loc)];
    return {
      kind: "libCall",
      fn: opts.signal ? "sp.pipelineOptsSignal" : "sp.pipelineOpts",
      args: opts.signal ? [...head, opts.signal] : head,
      type: { kind: "promise", inner: VOID },
      loc,
    };
  }
  return {
    kind: "libCall",
    fn: "sp.pipeline",
    args: [numLit(streams.length, loc), ...streams],
    type: { kind: "promise", inner: VOID },
    loc,
  };
}

/** The node:stream and stream/consumers members of lowerStreamModuleCall. */
function lowerStreamModuleCallbackCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module === "stream/consumers") {
    const args = call.arguments.nodes;
    // text/json/buffer/arrayBuffer(stream) → a pending promise the
    // accumulate-and-settle machinery resolves at the terminal point (the
    // utf8 decode / the parsed JSON dyn tree / the concatenated bytes / an
    // ArrayBuffer dyn over them) or rejects — with the stream's error,
    // ERR_STREAM_PREMATURE_CLOSE on an early close, or json's SyntaxError
    // on malformed text, Node's own rejection set. blob returns null here,
    // so the module-qualified fence (with the pointed hint in
    // BUILTIN_MODULE_FENCE_HINTS) speaks.
    if (
      bi.member === "text" ||
      bi.member === "json" ||
      bi.member === "buffer" ||
      bi.member === "arrayBuffer"
    ) {
      if (args.length !== 1) {
        lowerer.noLowering(
          `stream/consumers.${bi.member} with ${args.length} arguments`,
          call,
          `the supported form is ${bi.member}(stream)`,
        );
      }
      // A provably-non-stream argument: Node's consumers reject the
      // returned promise asynchronously with the plain "stream is not
      // async iterable" TypeError — no sync ladder exists to borrow
      // (finished/pipeline throw synchronously; consumers do not). A
      // sync throw here would be observably wrong timing, so the
      // provable case takes the named fence instead.
      // A Hash, Hmac, Cipheriv or Decipheriv is read through its Transform.
      const argV = isValueStream(lowerer, args[0]!)
        ? valueStreamOf(lowerer.lowerExpr(args[0]!))
        : lowerer.lowerExpr(args[0]!);
      const argInfo =
        argV.type.kind === "object" ? lowerer.classes.get(argV.type.className) : undefined;
      if (argV.type.kind !== "dyn" && !streamSidesOf(lowerer, argInfo)) {
        lowerer.noLowering(
          `stream/consumers.${bi.member} over a value that is not a stream`,
          call,
          "Node rejects the promise with 'stream is not async iterable' — pass a readable stream",
        );
      }
      const recv: IrExpr = argV;
      const inner: IrType = bi.member === "text" ? STRING : bi.member === "buffer" ? BYTES : DYN;
      return {
        kind: "libCall",
        fn: `sc.${bi.member}` as IrLibFn,
        args: [recv],
        type: { kind: "promise", inner },
        loc,
      };
    }
    return null;
  }
  if (bi.module !== "stream") return null;
  const args = call.arguments.nodes;

  if (bi.member === "getDefaultHighWaterMark") {
    // Node 24: 65536 bytes / 16 objects — compile-time literals only.
    // The byte default is platform-split at Node's source
    // (lib/internal/streams/state.js: win32 keeps 16 KiB), so the fold
    // follows the TARGET platform like the path-module binding.
    if (args.length === 1 && args[0]!.kind === ts.SyntaxKind.FalseKeyword) {
      return numLit(lowerer.targetPlatform === "win32" ? 16384 : 65536, loc);
    }
    if (args.length === 1 && args[0]!.kind === ts.SyntaxKind.TrueKeyword) return numLit(16, loc);
    lowerer.noLowering(
      "getDefaultHighWaterMark with a non-literal argument",
      call,
      "the objectMode flag must be a compile-time boolean",
    );
  }

  if (bi.member === "addAbortSignal") {
    // addAbortSignal(signal, stream) → the stream: destroyed with an
    // AbortError when the signal aborts (now, if it already has).
    if (args.length !== 2) {
      lowerer.noLowering(
        `addAbortSignal with ${args.length} arguments`,
        call,
        "the supported form is addAbortSignal(signal, stream)",
      );
    }
    const signal = lowerer.lowerExprExpecting(args[0]!, DYN);
    let stream: IrExpr;
    try {
      stream = lowerStreamArg(lowerer, args[1]!, "addAbortSignal");
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    return {
      kind: "libCall",
      fn: "stream.addAbortSignalFn",
      args: [signal, stream],
      type: stream.type,
      loc,
    };
  }

  if (bi.member === "finished") {
    if (args.length !== 2 && args.length !== 3) {
      lowerer.noLowering(
        `finished with ${args.length} arguments`,
        call,
        "the supported forms are finished(stream, callback) and finished(stream, options, callback)",
      );
    }
    let recv: IrExpr;
    try {
      recv = lowerStreamArg(lowerer, args[0]!, "finished");
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    if (args.length === 3 && args[1]!.kind !== ts.SyntaxKind.NullKeyword) {
      const o = eosOptions(lowerer, args[1]!, false);
      const { cb } = lowerEosCallback(lowerer, "finished", args[2]!, recv.type);
      const head: IrExpr[] = [
        recv,
        numLit(o.readable, loc),
        numLit(o.writable, loc),
        boolLit(o.error, loc),
      ];
      return {
        kind: "libCall",
        fn: o.signal ? "stream.finishedOptsSignal" : "stream.finishedOpts",
        args: o.signal ? [...head, o.signal, cb] : [...head, cb],
        type: funcOf([], VOID),
        loc,
      };
    }
    const { cb, dyn } = lowerEosCallback(lowerer, "finished", args[args.length - 1]!, recv.type);
    return {
      kind: "libCall",
      fn: dyn ? "stream.finishedDyn" : "stream.finished",
      args: [recv, cb],
      type: funcOf([], VOID),
      loc,
    };
  }

  if (bi.member === "pipeline") {
    if (args.length < 3) {
      lowerer.noLowering(
        `pipeline with ${args.length} arguments`,
        call,
        "the supported form is pipeline(source, ...streams, callback)",
      );
    }
    const build = (src: DynPipelineSource | null): IrExpr =>
      lowerDynStagePipeline(lowerer, args.slice(0, -1), src, loc, (plan) =>
        lowerCallbackPipeline(lowerer, call, args, plan, loc),
      );
    return lowerDynSourcePipeline(lowerer, args[0]!, loc, build) ?? build(null);
  }

  if (bi.member === "compose") {
    if (call.arguments.nodes.some((a) => ts.isSpreadElement(a))) {
      lowerer.noLowering("compose with spread arguments", call, "pass the streams directly");
    }
    return lowerStreamCompose(lowerer, call.arguments.nodes, loc);
  }

  return null;
}

/** pipeline(...stages, callback), for one branch of lowerDynStagePipeline's
 * plan. */
function lowerCallbackPipeline(
  lowerer: Lowerer,
  call: ts.CallExpression,
  args: readonly ts.Expression[],
  plan: DynStagePlan,
  loc: SrcLoc,
): IrExpr {
  const src = plan.source;
  const cbNode = args[args.length - 1]!;
  const cbParams =
    ts.isArrowFunction(cbNode) || ts.isFunctionExpression(cbNode)
      ? cbNode.parameters.nodes.length
      : 0;
  // A branch over untyped stages whose destination is a stream: the
  // callback still receives (err, value), value undefined, as in Node.
  const dynCallback = plan.bound.size > 0 && cbParams > 1;
  if (
    src?.iterable === true ||
    plan.fns.size > 0 ||
    plan.preSource !== undefined ||
    hasPipelineFunctionStage(lowerer, args.slice(0, -1))
  ) {
    const staged = lowerPipelineStages(lowerer, args.slice(0, -1), loc, ...stagesSource(src), plan);
    if (staged.dest >= 2 || (staged.dest === 1 && cbParams > 1) || dynCallback) {
      // callback(err, value): the destination's value (undefined for
      // an async generator) reaches the callback through the
      // checked-dynamic path.
      const cb = lowerer.lowerExprExpecting(args[args.length - 1]!, DYN);
      // SCR_PIPE_TYPED_CB: a typed callback whose error parameter cannot
      // hold undefined takes null for no error; others take undefined.
      const stagedArgs = [...staged.args];
      const flagsArg = stagedArgs[3]!;
      if (flagsArg.kind !== "numLit")
        throw new InternalCompilerError("pipeline flags not a literal");
      if (
        !isJsSourceFile(ts.getSourceFileOfNode(call)) &&
        !callbackErrorAdmitsUndefined(lowerer, cb)
      )
        stagedArgs[3] = numLit(flagsArg.value | 128, loc);
      return staged.wrap({
        kind: "libCall",
        fn: "stream.pipelineStagesDyn",
        args: [...stagedArgs, cb],
        type: staged.last,
        loc,
      });
    }
    const { cb, dyn } = lowerEosCallback(lowerer, "pipeline", args[args.length - 1]!, staged.last);
    return staged.wrap({
      kind: "libCall",
      fn: dyn ? "stream.pipelineStagesDyn" : "stream.pipelineStages",
      args: [...staged.args, cb],
      type: staged.last,
      loc,
    });
  }
  let streams: IrExpr[];
  try {
    streams = args.slice(0, -1).map((a, i) => planStreamArg(lowerer, plan, a, i));
  } catch (e) {
    if (e instanceof StreamArgTypeThrow) return e.expr;
    throw e;
  }
  const last = streams[streams.length - 1]!;
  const { cb, dyn } = dynCallback
    ? { cb: lowerer.lowerExprExpecting(cbNode, DYN), dyn: true }
    : lowerEosCallback(lowerer, "pipeline", cbNode, last.type);
  return {
    kind: "libCall",
    fn: dyn ? "stream.pipelineDyn" : "stream.pipeline",
    args: [numLit(streams.length, loc), ...streams, cb],
    type: last.type,
    loc,
  };
}

/** A pipeline() function stage: an inline function or arrow function, or
 * an identifier bound to a function declaration or to a `const`
 * initialized with one, which nothing reassigns. */
type StageFunction = ts.FunctionExpression | ts.ArrowFunction | ts.FunctionDeclaration;

/** The function a pipeline() argument writes or names, or null when the
 * argument is not a function stage. */
function pipelineStageFunction(lowerer: Lowerer, node: ts.Expression): StageFunction | null {
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
  if (!ts.isIdentifier(node)) return null;
  // The stage lowers the declaration's body again with its source typed
  // by the pipeline, so resolving it here must not report what collecting
  // the declaration's own signature deferred (resolveValueSymbol would).
  const resolve = (ident: ts.Identifier): ts.Symbol | undefined => {
    const found = lowerer.checker.getSymbolAtLocation(ident);
    return found && found.flags & ts.SymbolFlags.Alias
      ? lowerer.checker.getAliasedSymbol(found)
      : found;
  };
  const symbol = resolve(node);
  const declarations = symbol?.declarations ?? [];
  const bodies = declarations.filter((d) => !ts.isFunctionDeclaration(d) || d.body !== undefined);
  if (!symbol || bodies.length !== 1) return null;
  const decl = bodies[0]!;
  if (lowerer.isStdlibFile(ts.getSourceFileOfNode(decl))) return null;
  if (ts.isFunctionDeclaration(decl)) {
    return bindingNeverReassigned(lowerer, symbol, decl, resolve) ? decl : null;
  }
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
  }
  return null;
}

function hasPipelineFunctionStage(lowerer: Lowerer, args: readonly ts.Expression[]): boolean {
  return (
    args.some((a) => pipelineStageFunction(lowerer, a) !== null) ||
    (args.length > 0 && iterableSourceType(lowerer, args[0]!) !== null)
  );
}

type SyncGenType = IrType & { kind: "generator" };

/** The element type of a pipeline source that is an iterable value (an
 * array, a string or a synchronous generator object), or null. */
function iterableSourceType(lowerer: Lowerer, node: ts.Expression): IrType | null {
  if (pipelineStageFunction(lowerer, node) !== null) return null;
  const webElem = staticReadableStreamElementType(lowerer, node);
  if (webElem !== null) return webElem;
  let t: IrType | null;
  try {
    t = lowerer.mapTypeOf(lowerer.typeOf(node));
  } catch {
    return null;
  }
  if (t?.kind === "array") return t.elem;
  if (t?.kind === "string") return STRING;
  if (t?.kind === "generator" && t.async !== true && stepDrivable(t)) return t.yieldT;
  return null;
}

/** A pipeline source that is an iterable value or a synchronous generator
 * function without parameters, as an async generator closure that steps
 * the value's iterator (or the generator the function returns) and yields
 * each element. Node's pipeline iterates such a source with `for await`,
 * through an async-from-sync iterator, and an async generator that
 * yields the same elements resumes its consumer on the same ticks. Null
 * when the source has no such lowering. */
/** A web ReadableStream source, as an async generator closure over its
 * reader: each pass awaits reader.read() and yields the chunk, as the
 * stream's async iterator does; leaving early cancels the stream (its
 * iterator's return()), and the reader's lock is released either way. */
function lowerWebStreamSource(
  lowerer: Lowerer,
  node: ts.Expression,
  elemT: IrType,
  loc: SrcLoc,
): { closure: IrExpr; out: SyncGenType } | null {
  const resultT = genResultRecord(elemT, VOID, lowerer.shapes, lowerer.unions);
  if (!resultT) return null;
  const valueField = lowerer.shapes.get(resultT.shapeId)?.fields.find((f) => f.name === "value");
  if (!valueField) return null;
  const out: SyncGenType = {
    kind: "generator",
    async: true,
    yieldT: elemT,
    retT: VOID,
    nextT: UNDEFINED_T,
  };
  const genResultT = genResultRecord(elemT, VOID, lowerer.shapes, lowerer.unions);
  if (!genResultT) return null;
  const value = lowerer.lowerExprExpecting(node, DYN);
  const key = `webStreamSource:${typeKey(elemT)}`;
  let maker = lowerer.valueHelpers.get(key);
  if (!maker) {
    maker = `%stream.webStreamSource.${lowerer.valueHelpers.size}`;
    const genName = `${maker}.gen`;
    const frame = new LiftedFrame(loc);
    const srcId = frame.local("src", DYN, false);
    const readerId = frame.local("reader", DYN, false);
    const activeId = frame.local("active", BOOL, true);
    const promiseT: IrType = { kind: "promise", inner: resultT };
    const pId = frame.local("p", promiseT, false);
    const rId = frame.local("r", resultT, false);
    const reader = (): IrExpr => varRef(readerId, DYN, loc);
    const r = (): IrExpr => varRef(rId, resultT, loc);
    const setActive = (on: boolean): IrStmt => ({
      kind: "assign",
      localId: activeId,
      value: { kind: "boolLit", value: on, type: BOOL, loc },
      loc,
    });
    const extracted = extractIteratorValue(
      lowerer,
      elemT,
      valueField.type,
      {
        kind: "recordGet",
        obj: r(),
        shapeId: resultT.shapeId,
        field: "value",
        type: valueField.type,
        loc,
      },
      loc,
    );
    if (!extracted) return null;
    const invoke = (method: string, args: IrExpr[], calleeName: string): IrExpr => ({
      kind: "dynInvoke",
      recv: reader(),
      method,
      calleeName,
      args,
      type: DYN,
      loc,
    });
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: readerId,
        init: {
          kind: "dynInvoke",
          recv: varRef(srcId, DYN, loc),
          method: "getReader",
          calleeName: "ReadableStream async iterator",
          args: [],
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: activeId,
        init: { kind: "boolLit", value: false, type: BOOL, loc },
        loc,
      },
      {
        kind: "tryCatch",
        tryBody: [
          {
            kind: "while",
            cond: { kind: "boolLit", value: true, type: BOOL, loc },
            body: [
              setActive(false),
              {
                kind: "varDecl",
                localId: pId,
                init: {
                  kind: "libCall",
                  fn: "fetch.readerRead",
                  args: [reader()],
                  type: promiseT,
                  loc,
                },
                loc,
              },
              {
                kind: "varDecl",
                localId: rId,
                init: { kind: "awaitExpr", value: varRef(pId, promiseT, loc), type: resultT, loc },
                loc,
              },
              {
                kind: "if",
                cond: {
                  kind: "recordGet",
                  obj: r(),
                  shapeId: resultT.shapeId,
                  field: "done",
                  type: BOOL,
                  loc,
                },
                then: [{ kind: "break", loc }],
                else_: null,
                loc,
              },
              setActive(true),
              {
                kind: "exprStmt",
                expr: { kind: "yieldExpr", value: extracted, type: VOID, loc },
                loc,
              },
            ],
            loc,
          },
        ],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [
          {
            kind: "tryCatch",
            tryBody: [
              {
                kind: "if",
                cond: varRef(activeId, BOOL, loc),
                then: [
                  {
                    kind: "exprStmt",
                    expr: {
                      kind: "libCall",
                      fn: "async.awaitDyn",
                      args: [
                        invoke(
                          "cancel",
                          [dynUndefinedExpr(loc)],
                          "ReadableStream async iterator return",
                        ),
                      ],
                      type: DYN,
                      loc,
                    },
                    loc,
                  },
                ],
                else_: null,
                loc,
              },
            ],
            catchBody: null,
            catchLocalId: null,
            finallyBody: [
              {
                kind: "exprStmt",
                expr: invoke("releaseLock", [], "ReadableStream async iterator releaseLock"),
                loc,
              },
            ],
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: null, loc },
    ];
    const srcLocal = frame.locals.find((l) => l.id === srcId)!;
    srcLocal.boxed = true;
    lowerer.valueHelpers.set(key, maker);
    lowerer.liftedFns.push({
      name: genName,
      params: [],
      returnType: VOID,
      async: true,
      captures: [{ localId: srcId, name: "src", type: DYN }],
      locals: frame.locals,
      body,
      generator: { yieldT: elemT, nextT: UNDEFINED_T, resultType: genResultT },
      loc,
    });
    const makerSrc: IrLocal = { id: "src.0", name: "src", type: DYN, mutable: false, boxed: true };
    lowerer.liftedFns.push({
      name: maker,
      params: [{ localId: makerSrc.id, name: makerSrc.name, type: DYN }],
      returnType: funcOf([], out),
      locals: [makerSrc],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: genName,
            captures: [makerSrc.id],
            type: funcOf([], out),
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    closure: { kind: "call", callee: maker, args: [value], type: funcOf([], out), loc },
    out,
  };
}

/** A checked-dynamic pipeline source that is an iterable at run time
 * (stream.dynIterableSource), as an async generator closure that iterates
 * it as Node's pipeline does with `for await`: the value's async iterator,
 * or its sync iterator stepped like the typed iterable sources. Each value
 * is yielded; leaving early closes the iterator through its return(). */
function lowerDynIterableSource(
  lowerer: Lowerer,
  value: IrExpr,
  loc: SrcLoc,
): { closure: IrExpr; out: SyncGenType } | null {
  const out: SyncGenType = {
    kind: "generator",
    async: true,
    yieldT: DYN,
    retT: VOID,
    nextT: UNDEFINED_T,
  };
  const genResultT = genResultRecord(DYN, VOID, lowerer.shapes, lowerer.unions);
  if (!genResultT) return null;
  const key = "dynIterableSource";
  let maker = lowerer.valueHelpers.get(key);
  if (!maker) {
    maker = `%stream.dynIterableSource.${lowerer.valueHelpers.size}`;
    const genName = `${maker}.gen`;
    const frame = new LiftedFrame(loc);
    const srcId = frame.local("src", DYN, false);
    const itId = frame.local("it", DYN, false);
    const syncId = frame.local("sync", BOOL, false);
    const nextId = frame.local("next", DYN, false);
    const stepId = frame.local("step", DYN, true);
    const valueId = frame.local("value", DYN, true);
    const activeId = frame.local("active", BOOL, true);
    const closeId = frame.local("close", DYN, false);
    const it = (): IrExpr => varRef(itId, DYN, loc);
    const sync = (): IrExpr => varRef(syncId, BOOL, loc);
    const step = (): IrExpr => varRef(stepId, DYN, loc);
    const value = (): IrExpr => varRef(valueId, DYN, loc);
    // for await over a sync iterator awaits each value, the final one
    // included (CreateAsyncFromSyncIterator): an object (a promise or a
    // thenable) passes on its result
    const awaitsValue = (): IrExpr => ({
      kind: "logical",
      op: "&&",
      left: sync(),
      right: {
        kind: "logical",
        op: "||",
        left: { kind: "dynTest", test: "promise", value: value(), type: BOOL, loc },
        right: {
          kind: "logical",
          op: "&&",
          left: {
            kind: "dynTest",
            test: "nullish",
            negated: true,
            value: value(),
            type: BOOL,
            loc,
          },
          right: { kind: "dynTest", test: "object", value: value(), type: BOOL, loc },
          type: BOOL,
          loc,
        },
        type: BOOL,
        loc,
      },
      type: BOOL,
      loc,
    });
    const get = (obj: IrExpr, name: string): IrExpr => ({
      kind: "dynKeyGet",
      value: obj,
      key: strLit(name, loc),
      type: DYN,
      loc,
    });
    const awaitDyn = (v: IrExpr): IrExpr => ({
      kind: "libCall",
      fn: "async.awaitDyn",
      args: [v],
      type: DYN,
      loc,
    });
    const call = (callee: IrExpr, calleeName: string): IrExpr => ({
      kind: "dynCall",
      callee,
      receiver: it(),
      calleeName,
      args: [],
      type: DYN,
      loc,
    });
    const setActive = (on: boolean): IrStmt => ({
      kind: "assign",
      localId: activeId,
      value: boolLit(on, loc),
      loc,
    });
    const nextCall = (): IrExpr => call(varRef(nextId, DYN, loc), "iterator method");
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: itId,
        init: {
          kind: "libCall",
          fn: "dyn.iteratorResult",
          args: [
            {
              kind: "libCall",
              fn: "dyn.asyncIteratorOpen",
              args: [varRef(srcId, DYN, loc), strLit("", loc)],
              type: DYN,
              loc,
            },
          ],
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: syncId,
        init: { kind: "libCall", fn: "dyn.asyncIteratorWasSync", args: [], type: BOOL, loc },
        loc,
      },
      { kind: "varDecl", localId: nextId, init: get(it(), "next"), loc },
      { kind: "varDecl", localId: stepId, init: dynUndefinedExpr(loc), loc },
      { kind: "varDecl", localId: valueId, init: dynUndefinedExpr(loc), loc },
      { kind: "varDecl", localId: activeId, init: boolLit(false, loc), loc },
      {
        kind: "tryCatch",
        tryBody: [
          {
            kind: "while",
            cond: boolLit(true, loc),
            body: [
              setActive(false),
              {
                kind: "assign",
                localId: stepId,
                value: {
                  kind: "libCall",
                  fn: "dyn.iteratorResult",
                  args: [
                    {
                      kind: "ternary",
                      cond: sync(),
                      then: nextCall(),
                      else_: awaitDyn(nextCall()),
                      type: DYN,
                      loc,
                    },
                  ],
                  type: DYN,
                  loc,
                },
                loc,
              },
              {
                kind: "if",
                cond: {
                  kind: "dynTest",
                  test: "truthy",
                  value: get(step(), "done"),
                  type: BOOL,
                  loc,
                },
                // a sync iterator's final value is awaited too: a rejection
                // rejects the pump, and the finished iterator is not closed.
                // An async iterator's final value is not read.
                then: [
                  {
                    kind: "if",
                    cond: sync(),
                    then: [
                      { kind: "assign", localId: valueId, value: get(step(), "value"), loc },
                      {
                        kind: "if",
                        cond: awaitsValue(),
                        then: [{ kind: "exprStmt", expr: awaitDyn(value()), loc }],
                        else_: null,
                        loc,
                      },
                    ],
                    else_: null,
                    loc,
                  },
                  { kind: "break", loc },
                ],
                else_: null,
                loc,
              },
              setActive(true),
              { kind: "assign", localId: valueId, value: get(step(), "value"), loc },
              // a rejection here closes the iterator
              {
                kind: "if",
                cond: awaitsValue(),
                then: [{ kind: "assign", localId: valueId, value: awaitDyn(value()), loc }],
                else_: null,
                loc,
              },
              {
                kind: "exprStmt",
                expr: { kind: "yieldExpr", value: value(), type: VOID, loc },
                loc,
              },
            ],
            loc,
          },
        ],
        catchBody: null,
        catchLocalId: null,
        finallyBody: [
          {
            kind: "if",
            cond: varRef(activeId, BOOL, loc),
            then: [
              { kind: "varDecl", localId: closeId, init: get(it(), "return"), loc },
              {
                kind: "if",
                cond: {
                  kind: "unary",
                  op: "!",
                  operand: {
                    kind: "dynTest",
                    test: "nullish",
                    value: varRef(closeId, DYN, loc),
                    type: BOOL,
                    loc,
                  },
                  type: BOOL,
                  loc,
                },
                then: [
                  {
                    kind: "exprStmt",
                    expr: awaitDyn(call(varRef(closeId, DYN, loc), "iterator return")),
                    loc,
                  },
                ],
                else_: null,
                loc,
              },
            ],
            else_: null,
            loc,
          },
        ],
        loc,
      },
      { kind: "return", value: null, loc },
    ];
    const srcLocal = frame.locals.find((l) => l.id === srcId)!;
    srcLocal.boxed = true;
    lowerer.valueHelpers.set(key, maker);
    lowerer.liftedFns.push({
      name: genName,
      params: [],
      returnType: VOID,
      async: true,
      captures: [{ localId: srcId, name: "src", type: DYN }],
      locals: frame.locals,
      body,
      generator: { yieldT: DYN, nextT: UNDEFINED_T, resultType: genResultT },
      loc,
    });
    const makerSrc: IrLocal = { id: "src.0", name: "src", type: DYN, mutable: false, boxed: true };
    lowerer.liftedFns.push({
      name: maker,
      params: [{ localId: makerSrc.id, name: makerSrc.name, type: DYN }],
      returnType: funcOf([], out),
      locals: [makerSrc],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: genName,
            captures: [makerSrc.id],
            type: funcOf([], out),
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    closure: { kind: "call", callee: maker, args: [value], type: funcOf([], out), loc },
    out,
  };
}

/** The async generator a checked-dynamic stage's iterable is pumped
 * through. */
function dynStageGenType(): SyncGenType {
  return { kind: "generator", async: true, yieldT: DYN, retT: VOID, nextT: UNDEFINED_T };
}

/** A checked-dynamic pipeline stage after the first that is a function at
 * run time, as the stage closure the runtime calls with the previous
 * stage and { signal } (pipelineImpl's `typeof stream === 'function'`
 * branch): it calls the function with the previous stream or generator
 * as an untyped value. Before the last stage the result must be async
 * iterable (ERR_INVALID_RETURN_VALUE otherwise) and is pumped on through
 * lowerDynIterableSource's generator; the last stage answers the result,
 * which the runtime classifies (SCR_PIPE_DEST_DYN). A previous stage
 * whose type has no untyped form throws the not-supported Error. */
function lowerDynFunctionStage(
  lowerer: Lowerer,
  fnValue: IrExpr,
  srcT: IrType,
  j: number,
  isLast: boolean,
  loc: SrcLoc,
  handoff?: DynStageHandoff,
): { closure: IrExpr; out: IrType } {
  const out: IrType = isLast ? DYN : dynStageGenType();
  const stageT = funcOf([srcT, DYN], out);
  const take = handoff?.take === true;
  const give = handoff?.give === true && !isLast;
  const key = `dynFunctionStage:${isLast ? "dest" : "transform"}:${typeKey(srcT)}:${take ? 1 : 0}${give ? 1 : 0}`;
  let maker = lowerer.valueHelpers.get(key);
  if (!maker) {
    maker = `%stream.dynFunctionStage.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, maker);
    const stageName = `${maker}.stage`;
    const frame = new LiftedFrame(loc);
    const fnId = frame.local("fn", DYN, false);
    const labelId = frame.local("label", STRING, false);
    const cellId = frame.local("cell", DYN, false);
    const srcId = frame.param("src", srcT);
    const optsId = frame.param("opts", DYN);
    const inputId = frame.local("input", DYN, false);
    const resultId = frame.local("result", DYN, false);
    const nextId = frame.local("next", DYN, false);
    const cell = (): IrExpr => varRef(cellId, DYN, loc);
    const body: IrStmt[] = [];
    if (take) {
      // the previous untyped stage's value, handed over as it is
      // (makeAsyncIterable answers an iterable itself)
      body.push(
        { kind: "varDecl", localId: inputId, init: handoffTake(cell(), loc), loc },
        handoffPut(cell(), dynUndefinedExpr(loc), loc),
      );
    }
    if (!take && !lowerer.dynConvertible(srcT)) {
      body.push({
        kind: "return",
        value: nodeThrowExpr(
          0,
          "SC2020",
          `pipeline function stages after a stage of type '${lowerer.fmt(srcT)}' are not supported yet`,
          out,
          loc,
        ),
        loc,
      });
    } else {
      body.push({
        kind: "varDecl",
        localId: resultId,
        init: {
          kind: "dynCall",
          callee: varRef(fnId, DYN, loc),
          receiver: dynUndefinedExpr(loc),
          calleeName: "transform",
          args: [
            take
              ? varRef(inputId, DYN, loc)
              : { kind: "dynFrom", value: varRef(srcId, srcT, loc), type: DYN, loc },
            varRef(optsId, DYN, loc),
          ],
          type: DYN,
          loc,
        },
        loc,
      });
      if (isLast) {
        body.push({ kind: "return", value: varRef(resultId, DYN, loc), loc });
      } else {
        body.push({
          kind: "varDecl",
          localId: nextId,
          init: {
            kind: "libCall",
            fn: "stream.dynTransformResult",
            args: [varRef(resultId, DYN, loc), varRef(labelId, STRING, loc)],
            type: DYN,
            loc,
          },
          loc,
        });
        // the next untyped function stage takes the result itself; the
        // generator returned for the runtime is then never read
        if (give) body.push(handoffPut(cell(), varRef(nextId, DYN, loc), loc));
        const iterable = lowerDynIterableSource(lowerer, varRef(nextId, DYN, loc), loc);
        if (!iterable)
          throw new InternalCompilerError("dyn iterable generator without a result record");
        body.push({
          kind: "return",
          value: { kind: "callValue", callee: iterable.closure, args: [], type: out, loc },
          loc,
        });
      }
    }
    const captured = take || give ? [fnId, labelId, cellId] : [fnId, labelId];
    for (const id of captured) frame.locals.find((l) => l.id === id)!.boxed = true;
    lowerer.liftedFns.push({
      name: stageName,
      params: frame.params,
      returnType: out,
      captures: [
        { localId: fnId, name: "fn", type: DYN },
        { localId: labelId, name: "label", type: STRING },
        ...(take || give ? [{ localId: cellId, name: "cell", type: DYN }] : []),
      ],
      locals: frame.locals,
      body,
      loc,
    });
    const makerFn: IrLocal = { id: "fn.0", name: "fn", type: DYN, mutable: false, boxed: true };
    const makerLabel: IrLocal = {
      id: "label.1",
      name: "label",
      type: STRING,
      mutable: false,
      boxed: true,
    };
    const makerCell: IrLocal = {
      id: "cell.2",
      name: "cell",
      type: DYN,
      mutable: false,
      boxed: true,
    };
    const makerLocals = take || give ? [makerFn, makerLabel, makerCell] : [makerFn, makerLabel];
    lowerer.liftedFns.push({
      name: maker,
      params: makerLocals.map((l) => ({ localId: l.id, name: l.name, type: l.type })),
      returnType: stageT,
      locals: makerLocals,
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: stageName,
            captures: makerLocals.map((l) => l.id),
            type: stageT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    closure: {
      kind: "call",
      callee: maker,
      args: [fnValue, strLit(`transform[${j - 1}]`, loc), ...(take || give ? [handoff!.cell] : [])],
      type: stageT,
      loc,
    },
    out,
  };
}

/** The cell that carries an untyped stage's value to the untyped function
 * stage after it, created per pipeline call. A stage that gives stores its
 * value; the next stage takes it instead of the generator the runtime
 * passes, as Node's makeAsyncIterable answers an iterable itself. */
interface DynStageHandoff {
  cell: IrExpr;
  take: boolean;
  give: boolean;
}

function handoffPut(cell: IrExpr, value: IrExpr, loc: SrcLoc): IrStmt {
  return {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "dyn.keySet",
      args: [cell, strLit("v", loc), value],
      type: VOID,
      loc,
    },
    loc,
  };
}

function handoffTake(cell: IrExpr, loc: SrcLoc): IrExpr {
  return { kind: "dynKeyGet", value: cell, key: strLit("v", loc), type: DYN, loc };
}

/** `(value) => generator over value`: the async generator an untyped
 * destination function's async iterable result is pumped through
 * (SCR_PIPE_DEST_DYN's box), interned. */
function dynStageIterHelper(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const genT = dynStageGenType();
  const type = funcOf([DYN], genT);
  const key = "dynStageIter";
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = `%stream.dynStageIter.${lowerer.valueHelpers.size}`;
    lowerer.valueHelpers.set(key, name);
    const v: IrLocal = { id: "value.0", name: "value", type: DYN, mutable: false };
    const iterable = lowerDynIterableSource(lowerer, varRef(v.id, DYN, loc), loc);
    if (!iterable)
      throw new InternalCompilerError("dyn iterable generator without a result record");
    lowerer.liftedFns.push({
      name,
      params: [{ localId: v.id, name: v.name, type: DYN }],
      returnType: genT,
      locals: [v],
      body: [
        {
          kind: "return",
          value: { kind: "callValue", callee: iterable.closure, args: [], type: genT, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type, loc };
}

/** A checked-dynamic first pipeline stage pumped as an iterable
 * (pipelineImpl's i === 0 branch), as the stage closure the runtime calls
 * with { signal } while it sets the pipeline up: a function is called
 * with { signal } and its result must be iterable, a { readable, writable }
 * pair pumps its readable side, and any other value is pumped itself,
 * through lowerDynIterableSource's generator. */
function lowerDynSourceStage(
  lowerer: Lowerer,
  value: IrExpr,
  loc: SrcLoc,
  cell?: IrExpr,
): { closure: IrExpr; out: SyncGenType } | null {
  const out: SyncGenType = {
    kind: "generator",
    async: true,
    yieldT: DYN,
    retT: VOID,
    nextT: UNDEFINED_T,
  };
  const stageT = funcOf([DYN], out);
  const give = cell !== undefined;
  const key = give ? "dynSourceStage:give" : "dynSourceStage";
  let maker = lowerer.valueHelpers.get(key);
  if (!maker) {
    maker = `%stream.dynSourceStage.${lowerer.valueHelpers.size}`;
    const stageName = `${maker}.stage`;
    const frame = new LiftedFrame(loc);
    const srcId = frame.local("src", DYN, false);
    const cellId = frame.local("cell", DYN, false);
    const optsId = frame.param("opts", DYN);
    const valueId = frame.local("value", DYN, false);
    const genId = frame.local("gen", out, false);
    const src = (): IrExpr => varRef(srcId, DYN, loc);
    const sourceValue = (v: IrExpr, returned: boolean): IrExpr => ({
      kind: "libCall",
      fn: "stream.dynSourceValue",
      args: [v, boolLit(returned, loc)],
      type: DYN,
      loc,
    });
    const iterable = lowerDynIterableSource(lowerer, varRef(valueId, DYN, loc), loc);
    if (!iterable) return null;
    lowerer.valueHelpers.set(key, maker);
    const body: IrStmt[] = [
      {
        kind: "varDecl",
        localId: valueId,
        init: {
          kind: "ternary",
          cond: { kind: "dynTest", test: "function", value: src(), type: BOOL, loc },
          then: sourceValue(
            {
              kind: "dynCall",
              callee: src(),
              receiver: dynUndefinedExpr(loc),
              calleeName: "source",
              args: [varRef(optsId, DYN, loc)],
              type: DYN,
              loc,
            },
            true,
          ),
          else_: sourceValue(src(), false),
          type: DYN,
          loc,
        },
        loc,
      },
      {
        kind: "varDecl",
        localId: genId,
        init: { kind: "callValue", callee: iterable.closure, args: [], type: out, loc },
        loc,
      },
    ];
    if (give) {
      // the untyped function stage after the source takes the iterable
      // itself, as Node's makeAsyncIterable answers it; a stream (a pair's
      // readable side) goes as the generator over it, as Node iterates a
      // stream there
      const v = varRef(valueId, DYN, loc);
      body.push(
        handoffPut(
          varRef(cellId, DYN, loc),
          {
            kind: "ternary",
            cond: { kind: "libCall", fn: "stream.dynIterableSource", args: [v], type: BOOL, loc },
            then: v,
            else_: { kind: "dynFrom", value: varRef(genId, out, loc), type: DYN, loc },
            type: DYN,
            loc,
          },
          loc,
        ),
      );
    }
    body.push({ kind: "return", value: varRef(genId, out, loc), loc });
    const captured = give ? [srcId, cellId] : [srcId];
    for (const id of captured) frame.locals.find((l) => l.id === id)!.boxed = true;
    lowerer.liftedFns.push({
      name: stageName,
      params: frame.params,
      returnType: out,
      captures: [
        { localId: srcId, name: "src", type: DYN },
        ...(give ? [{ localId: cellId, name: "cell", type: DYN }] : []),
      ],
      locals: frame.locals,
      body,
      loc,
    });
    const makerSrc: IrLocal = { id: "src.0", name: "src", type: DYN, mutable: false, boxed: true };
    const makerCell: IrLocal = {
      id: "cell.1",
      name: "cell",
      type: DYN,
      mutable: false,
      boxed: true,
    };
    const makerLocals = give ? [makerSrc, makerCell] : [makerSrc];
    lowerer.liftedFns.push({
      name: maker,
      params: makerLocals.map((l) => ({ localId: l.id, name: l.name, type: l.type })),
      returnType: stageT,
      locals: makerLocals,
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: stageName,
            captures: makerLocals.map((l) => l.id),
            type: stageT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    closure: {
      kind: "call",
      callee: maker,
      args: give ? [value, cell!] : [value],
      type: stageT,
      loc,
    },
    out,
  };
}

function lowerIterableSource(
  lowerer: Lowerer,
  node: ts.Expression,
  fn: StageFunction | null,
  loc: SrcLoc,
): { closure: IrExpr; out: SyncGenType } | null {
  if (fn === null) {
    const webElem = staticReadableStreamElementType(lowerer, node);
    if (webElem !== null) return lowerWebStreamSource(lowerer, node, webElem, loc);
  }
  let value: IrExpr;
  if (fn !== null) {
    if (fn.parameters.nodes.length > 0) {
      lowerer.noLowering(
        "a synchronous generator function pipeline source with parameters",
        fn.parameters.nodes[0]!,
        "declare the source without parameters, or make it an async generator function",
      );
    }
    value = lowerer.lowerLambda(fn);
    if (value.type.kind !== "func" || value.type.ret.kind !== "generator") return null;
  } else {
    value = lowerer.lowerExpr(node);
  }
  const srcT = value.type;
  const elemT: IrType | null =
    srcT.kind === "func" && srcT.ret.kind === "generator"
      ? srcT.ret.yieldT
      : srcT.kind === "array"
        ? srcT.elem
        : srcT.kind === "string"
          ? STRING
          : srcT.kind === "generator" && srcT.async !== true
            ? srcT.yieldT
            : null;
  if (elemT === null) return null;
  const out: SyncGenType = {
    kind: "generator",
    async: true,
    yieldT: elemT,
    retT: VOID,
    nextT: UNDEFINED_T,
  };
  const resultType = genResultRecord(elemT, VOID, lowerer.shapes, lowerer.unions);
  if (!resultType) return null;
  const key = `pipelineSource:${typeKey(srcT)}`;
  let maker = lowerer.valueHelpers.get(key);
  if (!maker) {
    maker = `%stream.pipelineSource.${lowerer.valueHelpers.size}`;
    const genName = `${maker}.gen`;
    // The generator: g = the source's iterator; for (v of g) yield v.
    const frame = new LiftedFrame(loc);
    const srcId = frame.local("src", srcT, false);
    const src = varRef(srcId, srcT, loc);
    const syncT: SyncGenType = {
      kind: "generator",
      yieldT: elemT,
      retT: VOID,
      nextT: UNDEFINED_T,
    };
    let iterator: IrExpr | null;
    if (srcT.kind === "func") {
      iterator = { kind: "callValue", callee: src, args: [], type: srcT.ret, loc };
    } else if (srcT.kind === "array") {
      iterator = lowerArrayIteratorValue(lowerer, src, "values", syncT, loc);
    } else if (srcT.kind === "string") {
      iterator = lowerStringIteratorValue(lowerer, src, syncT, loc);
    } else {
      iterator = src;
    }
    if (iterator === null || iterator.type.kind !== "generator" || !stepDrivable(iterator.type))
      return null;
    const iterT = iterator.type;
    const gId = frame.local("g", iterT, false);
    const body: IrStmt[] = [
      { kind: "varDecl", localId: gId, init: iterator, loc },
      ...driveGenerator(
        lowerer,
        frame,
        gId,
        iterT,
        elemT,
        [],
        (v) => [{ kind: "exprStmt", expr: { kind: "yieldExpr", value: v, type: VOID, loc }, loc }],
        loc,
      ),
      { kind: "return", value: null, loc },
    ];
    const srcLocal = frame.locals.find((l) => l.id === srcId)!;
    srcLocal.boxed = true;
    lowerer.valueHelpers.set(key, maker);
    lowerer.liftedFns.push({
      name: genName,
      params: [],
      returnType: VOID,
      async: true,
      captures: [{ localId: srcId, name: "src", type: srcT }],
      locals: frame.locals,
      body,
      generator: { yieldT: elemT, nextT: UNDEFINED_T, resultType },
      loc,
    });
    // The maker: (src) => the generator function closed over src.
    const makerSrc: IrLocal = { id: "src.0", name: "src", type: srcT, mutable: false, boxed: true };
    lowerer.liftedFns.push({
      name: maker,
      params: [{ localId: makerSrc.id, name: makerSrc.name, type: srcT }],
      returnType: funcOf([], out),
      locals: [makerSrc],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: genName,
            captures: [makerSrc.id],
            type: funcOf([], out),
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    closure: { kind: "call", callee: maker, args: [value], type: funcOf([], out), loc },
    out,
  };
}

/** The lowered function stages of a pipeline: the libcall head [n, k,
 * positions, flags, mask, streams..., stages..., helpers..., box?,
 * (signal, abort)?], the destination's type (the last stream, or the
 * PassThrough a function destination answers), the destination kind
 * (SCR_PIPE_DEST_*), a promise destination's promise type, and a wrapper
 * that binds the pipeline's AbortController around the call when a
 * stage takes `{ signal }`. positions has bit j set when the pipeline's
 * j-th stage is a function; helpers holds (next, read, return) for each
 * generator pumped into a stream. */
interface PipelineStagesLowering {
  args: IrExpr[];
  last: IrType;
  dest: 0 | 1 | 2 | 3;
  destPromise: (IrType & { kind: "promise" }) | null;
  wrap: (call: IrExpr) => IrExpr;
}

/** pipeline(...) with function stages (pipeline.js). A function may
 * start the pipeline (a source function, called with `{ signal }`), may
 * end it (an async function whose promise's value reaches the callback or
 * the promise, or an async generator function), and runs of async
 * generator functions may sit between streams; the last generator of a
 * run that a stream follows is pumped into that stream. A function
 * destination feeds the object-mode PassThrough that pipeline() answers. Each stage's `source` parameter is typed as what the
 * pipeline passes it: makeAsyncIterable answers the previous stream
 * itself (a Readable is async iterable) or the previous stage's
 * generator. */
function lowerPipelineStages(
  lowerer: Lowerer,
  stageArgs: readonly ts.Expression[],
  loc: SrcLoc,
  preLowered?: ReadonlyMap<number, IrExpr>,
  dynSource?: IrExpr,
  plan?: DynStagePlan,
): PipelineStagesLowering {
  if (stageArgs.length > 52) {
    lowerer.noLowering(
      "pipeline with function stages and more than 52 stages",
      stageArgs[52]!,
      "split the pipeline",
    );
  }
  const streams: IrExpr[] = [];
  const stages: IrExpr[] = [];
  const helperArgs: IrExpr[] = [];
  let positions = 0;
  let mask = 0;
  let dest: 0 | 1 | 2 | 3 = 0;
  let destPromise: (IrType & { kind: "promise" }) | null = null;
  // What the next function stage receives: null before the first stage,
  // else the previous stream's type or the previous stage's generator.
  let srcT: IrType | null = null;
  // The streams and stages in argument order: the head lists all streams
  // before all stages, so when a stage precedes a stream the arguments
  // are bound to locals first, keeping JavaScript's evaluation order.
  const argOrder: { list: IrExpr[]; index: number }[] = [];
  // An untyped stage followed by an untyped function stage hands its value
  // over through one cell per call (DynStageHandoff).
  let handoffCell: IrLocal | null = null;
  const cellRef = (): IrExpr => {
    handoffCell ??= lowerer.declareHiddenLocal("%pipelineHandoff", DYN);
    return varRef(handoffCell.id, DYN, loc);
  };
  let takes = false;
  for (let j = 0; j < stageArgs.length; j++) {
    const arg = stageArgs[j]!;
    const givesToNext = plan?.fns.has(j + 1) === true;
    if (j === 0 && dynSource !== undefined) {
      const source = lowerDynSourceStage(
        lowerer,
        dynSource,
        loc,
        givesToNext ? cellRef() : undefined,
      );
      takes = givesToNext;
      if (source === null) lowerer.noLowering("pipeline over this source", arg);
      // a source function takes { signal }
      mask |= 1 << stages.length;
      positions += 1;
      argOrder.push({ list: stages, index: stages.length });
      stages.push(source!.closure);
      srcT = source!.out;
      continue;
    }
    if (plan?.fns.has(j) === true) {
      // a checked-dynamic stage that is a function at run time
      const isLast = j === stageArgs.length - 1;
      const take = takes;
      const give = givesToNext && !isLast;
      takes = give;
      const lowered = lowerDynFunctionStage(
        lowerer,
        plan.bound.get(j)!,
        srcT!,
        j,
        isLast,
        loc,
        take || give ? { cell: cellRef(), take, give } : undefined,
      );
      mask |= 1 << stages.length;
      positions += 2 ** j;
      argOrder.push({ list: stages, index: stages.length });
      stages.push(lowered.closure);
      if (isLast) {
        // its result is classified at run time: a promise settles the
        // pipeline's value, and an async iterable is pumped into the
        // PassThrough
        const genT = dynStageGenType();
        const helpers = fromGenHelpers(lowerer, genT, loc);
        if (!helpers) lowerer.noLowering("a pipeline destination with this generator type", arg);
        helperArgs.push(helpers![0]!, helpers![1]!, helpers![2]!);
        dest = 3;
        destPromise = { kind: "promise", inner: DYN };
        srcT = null;
      } else {
        srcT = lowered.out;
      }
      continue;
    }
    // compose's head and tail functions arrive as Duplex.from streams
    const fn = preLowered?.has(j) ? null : pipelineStageFunction(lowerer, arg);
    const syncSourceFn =
      j === 0 &&
      fn !== null &&
      !ts.isArrowFunction(fn) &&
      fn.asteriskToken !== undefined &&
      !(fn.modifiers?.nodes ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (
      j === 0 &&
      !preLowered?.has(j) &&
      (syncSourceFn || (fn === null && iterableSourceType(lowerer, arg) !== null))
    ) {
      const source =
        (syncSourceFn ? undefined : plan?.preSource) ??
        lowerIterableSource(lowerer, arg, syncSourceFn ? fn : null, loc);
      if (source === null) lowerer.noLowering("pipeline over this source", arg);
      positions += 1;
      argOrder.push({ list: stages, index: stages.length });
      stages.push(source!.closure);
      srcT = source!.out;
      continue;
    }
    if (fn === null) {
      if (srcT?.kind === "generator") {
        // the generator before this stream, pumped into it
        if (!fromGenChunk(lowerer, srcT.yieldT)) {
          lowerer.noLowering(
            `a pipeline stage yielding '${lowerer.fmt(srcT.yieldT)}'`,
            stageArgs[j - 1]!,
            "stage values written to a stream are strings or Buffers",
          );
        }
        const helpers = fromGenHelpers(lowerer, srcT, loc);
        if (!helpers)
          lowerer.noLowering("a pipeline stage with this generator type", stageArgs[j - 1]!);
        helperArgs.push(helpers![0]!, helpers![1]!, helpers![2]!);
      }
      let stream: IrExpr;
      try {
        const bound = plan?.bound.get(j);
        stream =
          preLowered?.get(j) ??
          (bound !== undefined
            ? streamArgOf(lowerer, arg, bound, "pipeline")
            : lowerStreamArg(lowerer, arg, "pipeline"));
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) lowerer.noLowering("pipeline over this value", arg);
        throw e;
      }
      argOrder.push({ list: streams, index: streams.length });
      streams.push(stream);
      srcT = stream.type;
      continue;
    }
    const isLast = j === stageArgs.length - 1;
    const isAsync = (fn.modifiers?.nodes ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const isGen = !ts.isArrowFunction(fn) && fn.asteriskToken !== undefined;
    if (!isAsync || (!isGen && !isLast)) {
      lowerer.noLowering(
        isLast
          ? "a pipeline destination that is not an async function"
          : srcT === null
            ? "a pipeline source function that is not an async generator function"
            : "pipeline stages that are not async generator functions",
        arg,
        "write the stage as async function* (source) { for await (const chunk of source) ... }",
      );
    }
    const optionsAt = srcT === null ? 0 : 1;
    if (fn.parameters.nodes.length > optionsAt + 1) {
      lowerer.noLowering(
        "pipeline stages with parameters after the options argument",
        fn.parameters.nodes[optionsAt + 1]!,
        "a stage takes the source and { signal }",
      );
    }
    const lowered = lowerStageFunction(lowerer, fn, srcT);
    const params = lowered.closure.type.kind === "func" ? lowered.closure.type.params : [];
    if (params.length > optionsAt) {
      if (params[optionsAt]!.kind !== "dyn") {
        lowerer.noLowering(
          "a pipeline stage's options argument with this type",
          fn.parameters.nodes[optionsAt]!,
          "type it as { signal: AbortSignal }",
        );
      }
      mask |= 1 << stages.length;
    }
    positions += 2 ** j;
    argOrder.push({ list: stages, index: stages.length });
    stages.push(lowered.closure);
    if (lowered.out.kind === "promise") {
      dest = 2;
      destPromise = lowered.out;
      srcT = null;
    } else if (isLast) {
      // an async generator destination: pumped into the object-mode
      // PassThrough that pipeline() answers
      const helpers = fromGenHelpers(lowerer, lowered.out, loc);
      if (!helpers) lowerer.noLowering("a pipeline destination with this generator type", arg);
      helperArgs.push(helpers![0]!, helpers![1]!, helpers![2]!);
      dest = 1;
      srcT = null;
    } else {
      srcT = lowered.out;
    }
  }
  if (dest === 2) {
    const valueT = destPromise!.inner;
    if (
      valueT.kind !== "void" &&
      !canConvertToDyn(
        valueT,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      lowerer.noLowering(
        `a pipeline destination resolving to '${lowerer.fmt(valueT)}'`,
        stageArgs[stageArgs.length - 1]!,
      );
    }
    helperArgs.push(pipelineBoxHelper(lowerer, destPromise!, loc));
  } else if (dest === 3) {
    helperArgs.push(dynStageIterHelper(lowerer, loc));
  }
  const argDecls: IrStmt[] = [];
  const firstStage = argOrder.findIndex((a) => a.list === stages);
  if (firstStage >= 0 && argOrder.slice(firstStage).some((a) => a.list === streams)) {
    for (const a of argOrder) {
      const init = a.list[a.index]!;
      const local = lowerer.declareHiddenLocal("%pipelineArg", init.type);
      argDecls.push({ kind: "varDecl", localId: local.id, init, loc: init.loc });
      a.list[a.index] = varRef(local.id, init.type, init.loc);
    }
  }
  if (handoffCell !== null) {
    const cell: IrLocal = handoffCell;
    argDecls.unshift({
      kind: "varDecl",
      localId: cell.id,
      init: { kind: "dynObjLit", fields: [], type: DYN, loc },
      loc,
    });
  }
  const bindArgs = (call: IrExpr): IrExpr =>
    argDecls.length === 0
      ? call
      : { kind: "seqExpr", stmts: argDecls, result: call, type: call.type, loc };
  // SCR_PIPE_* flags: bits 1-2 the destination, bit 5 the signal and
  // abort (bit 6, the promise form's options signal, is set by its caller).
  const flags = (dest << 1) | (mask !== 0 ? 32 : 0);
  const head: IrExpr[] = [
    numLit(streams.length, loc),
    numLit(stages.length, loc),
    numLit(positions, loc),
    numLit(flags, loc),
    numLit(mask, loc),
    ...streams,
    ...stages,
    ...helperArgs,
  ];
  const last: IrType =
    dest !== 0 ? { kind: "object", className: "%PassThrough" } : streams[streams.length - 1]!.type;
  if (mask === 0) return { args: head, last, dest, destPromise, wrap: bindArgs };
  // const ac = new AbortController(): its signal goes to the stages, and
  // finishImpl's ac.abort() runs through the abort closure.
  const ac = lowerer.declareHiddenLocal("%pipelineAbort", DYN);
  const acRef: IrExpr = { kind: "varRef", localId: ac.id, type: DYN, loc };
  const signal: IrExpr = {
    kind: "dynKeyGet",
    value: acRef,
    key: { kind: "strLit", value: "signal", type: STRING, loc },
    type: DYN,
    loc,
  };
  return {
    args: [...head, signal, pipelineAbortHelper(lowerer, acRef, loc)],
    last,
    dest,
    destPromise,
    wrap: (call) =>
      bindArgs({
        kind: "seqExpr",
        stmts: [
          {
            kind: "varDecl",
            localId: ac.id,
            init: { kind: "libCall", fn: "fetch.abortControllerNew", args: [], type: DYN, loc },
            loc,
          },
        ],
        result: call,
        type: call.type,
        loc,
      }),
  };
}

/** `(p) => p` boxed: a promise destination's promise as a checked-dynamic
 * promise, whose payload converts when the destination settles. Interned
 * per promise type. */
function pipelineBoxHelper(
  lowerer: Lowerer,
  promiseT: IrType & { kind: "promise" },
  loc: SrcLoc,
): IrExpr {
  const key = `pipelineBox:${typeKey(promiseT)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.pipelineBox", key);
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "p.0", name: "p", type: promiseT }],
      returnType: DYN,
      locals: [{ id: "p.0", name: "p", type: promiseT, mutable: false }],
      body: [
        {
          kind: "return",
          value: { kind: "dynFrom", value: varRef("p.0", promiseT, loc), type: DYN, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: funcOf([promiseT], DYN), loc };
}

/** `() => ac.abort()` over the pipeline's AbortController: an interned
 * lifted function takes the controller and answers the closure. */
function pipelineAbortHelper(
  lowerer: Lowerer,
  ac: IrExpr,
  loc: SrcLoc,
  withReason = false,
): IrExpr {
  const key = withReason ? "pipelineAbortReason" : "pipelineAbort";
  let name = lowerer.valueHelpers.get(key);
  const abortT = funcOf(withReason ? [DYN] : [], VOID);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.pipelineAbort", key);
    lowerer.valueHelpers.set(key, name);
    const acLocal: IrLocal = { id: "ac.0", name: "ac", type: DYN, mutable: false, boxed: true };
    const acRef = varRef(acLocal.id, DYN, loc);
    const reasonLocal: IrLocal = { id: "reason.0", name: "reason", type: DYN, mutable: false };
    lowerer.liftedFns.push({
      name: `${name}.abort`,
      params: withReason ? [{ localId: reasonLocal.id, name: reasonLocal.name, type: DYN }] : [],
      returnType: VOID,
      captures: [{ localId: acLocal.id, name: acLocal.name, type: DYN }],
      locals: withReason ? [acLocal, reasonLocal] : [acLocal],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "dynInvoke",
            recv: acRef,
            method: "abort",
            calleeName: "ac.abort",
            args: withReason ? [varRef(reasonLocal.id, DYN, loc)] : [],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: acLocal.id, name: acLocal.name, type: DYN }],
      returnType: abortT,
      locals: [acLocal],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: `${name}.abort`,
            captures: [acLocal.id],
            type: abortT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [ac], type: abortT, loc };
}

/** A function stage, lowered with its `source` parameter (absent for a
 * source function, srcT null) typed as what the pipeline passes (a
 * stream or the previous stage's generator). The source may only head
 * `for await` loops. Answers the closure and what it returns: an async
 * generator, or a promise for a destination async function. */
function lowerStageFunction(
  lowerer: Lowerer,
  fn: StageFunction,
  srcT: IrType | null,
): { closure: IrExpr; out: IrType & ({ kind: "generator" } | { kind: "promise" }) } {
  const param = srcT === null ? undefined : fn.parameters.nodes[0];
  const symbol =
    param && ts.isIdentifier(param.name)
      ? lowerer.checker.getSymbolAtLocation(param.name)
      : undefined;
  if (param && !symbol) {
    lowerer.noLowering(
      "pipeline stage parameters that are patterns",
      param,
      "name the source parameter",
    );
  }
  // The loop variables of the `for await` loops over the source.
  const chunkSymbols: ts.Symbol[] = [];
  if (symbol && fn.body) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== param!.name &&
        lowerer.checker.getSymbolAtLocation(node) === symbol
      ) {
        const parent = node.parent;
        if (
          !(
            parent &&
            ts.isForOfStatement(parent) &&
            parent.awaitModifier &&
            parent.expression === node
          )
        ) {
          lowerer.noLowering(
            "a pipeline stage's source used outside a for await loop head",
            node,
            "iterate the source with for await (const chunk of source)",
          );
        }
        const binding = ts.isVariableDeclarationList(parent.initializer)
          ? parent.initializer.declarations.nodes[0]?.name
          : undefined;
        const chunk =
          binding && ts.isIdentifier(binding)
            ? lowerer.checker.getSymbolAtLocation(binding)
            : undefined;
        if (chunk) chunkSymbols.push(chunk);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  }
  if (symbol) lowerer.stageSourceTypes.set(symbol, srcT!);
  // In JavaScript the checker types the chunks of a source that is the
  // previous stage's generator `any`; they read as the strings or Buffers
  // the generator yields, so their members take the string and Buffer
  // lowerings.
  const previousImplicit = lowerer.implicitParamTypes;
  const chunkType =
    srcT?.kind === "generator" && isJsSourceFile(ts.getSourceFileOfNode(fn))
      ? stageChunkCheckerType(lowerer, srcT.yieldT, fn)
      : null;
  if (chunkType && chunkSymbols.length > 0) {
    const implicit = new Map(previousImplicit ?? []);
    for (const chunk of chunkSymbols) implicit.set(chunk, chunkType);
    lowerer.implicitParamTypes = implicit;
  }
  try {
    const closure = lowerer.lowerLambda(fn);
    const out = closure.type.kind === "func" ? closure.type.ret : null;
    if (!(out?.kind === "generator" && out.async) && out?.kind !== "promise") {
      lowerer.noLowering("a pipeline stage that does not return an async generator", fn);
    }
    return { closure, out: out as IrType & ({ kind: "generator" } | { kind: "promise" }) };
  } finally {
    if (symbol) lowerer.stageSourceTypes.delete(symbol);
    lowerer.implicitParamTypes = previousImplicit;
  }
}

/** The async generator a Duplex.from body iterates (duplexify.js's
 * fromAsyncGen source), as a closure the runtime calls with next() and
 * ack(): each pass awaits next() (the deferred a write or the final
 * settles), calls ack() (process.nextTick(cb) and a fresh deferred),
 * returns at the done marker, and yields the chunk. */
function duplexSourceHelper(lowerer: Lowerer, genT: SyncGenType, loc: SrcLoc): IrExpr | null {
  const nextT = funcOf([], { kind: "promise", inner: DYN });
  const ackT = funcOf([], VOID);
  const type = funcOf([nextT, ackT], genT);
  const key = "duplexSource";
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    const resultType = genResultRecord(DYN, VOID, lowerer.shapes, lowerer.unions);
    if (!resultType) return null;
    name = `%stream.duplexSource.${lowerer.valueHelpers.size}`;
    const frame = new LiftedFrame(loc);
    const nextId = frame.param("next", nextT);
    const ackId = frame.param("ack", ackT);
    const valueId = frame.local("value", DYN, false);
    const value = varRef(valueId, DYN, loc);
    const body: IrStmt[] = [
      {
        kind: "while",
        cond: { kind: "boolLit", value: true, type: BOOL, loc },
        body: [
          {
            kind: "varDecl",
            localId: valueId,
            init: {
              kind: "awaitExpr",
              value: {
                kind: "callValue",
                callee: varRef(nextId, nextT, loc),
                args: [],
                type: { kind: "promise", inner: DYN },
                loc,
              },
              type: DYN,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "callValue",
              callee: varRef(ackId, ackT, loc),
              args: [],
              type: VOID,
              loc,
            },
            loc,
          },
          {
            kind: "if",
            cond: { kind: "libCall", fn: "stream.chunkDone", args: [value], type: BOOL, loc },
            then: [{ kind: "return", value: null, loc }],
            else_: null,
            loc,
          },
          { kind: "exprStmt", expr: { kind: "yieldExpr", value, type: VOID, loc }, loc },
        ],
        loc,
      },
      { kind: "return", value: null, loc },
    ];
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: frame.params,
      returnType: VOID,
      async: true,
      locals: frame.locals,
      body,
      generator: { yieldT: DYN, nextT: UNDEFINED_T, resultType },
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type, loc };
}

/** Duplex.from(body) (duplexify.js) for the bodies with a lowering: an
 * async generator function, whose source generator the Duplex's writes
 * feed (stream.duplexFromGen); a duplex stream, which answers itself; and
 * the bodies Readable.from reads (iterables, strings, generators), as a
 * Duplexify that is not writable. */
function duplexFromBody(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr {
  const duplex: IrType = { kind: "object", className: "%Duplex" };
  const fn = pipelineStageFunction(lowerer, node);
  if (fn !== null) {
    const isAsync = (fn.modifiers?.nodes ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const isGen = !ts.isArrowFunction(fn) && fn.asteriskToken !== undefined;
    if (!isAsync) {
      lowerer.noLowering(
        "Duplex.from over a function that is not async",
        node,
        "write the body as async function* (source) { ... } or async function (source) { ... }",
      );
    }
    if (fn.parameters.nodes.length > 2) {
      lowerer.noLowering(
        "a Duplex.from body with parameters after the options argument",
        fn.parameters.nodes[2]!,
        "the body takes the source and { signal }",
      );
    }
    const sourceT: SyncGenType = {
      kind: "generator",
      async: true,
      yieldT: DYN,
      retT: VOID,
      nextT: UNDEFINED_T,
    };
    const lowered = lowerStageFunction(lowerer, fn, sourceT);
    const params = lowered.closure.type.kind === "func" ? lowered.closure.type.params : [];
    // fromAsyncGen calls the body with { signal } of an AbortController
    // that destroy aborts with its error.
    let signalArgs: IrExpr[] = [];
    let signalDecls: IrStmt[] = [];
    if (params.length > 1) {
      if (params[1]!.kind !== "dyn") {
        lowerer.noLowering(
          "a Duplex.from body's options argument with this type",
          fn.parameters.nodes[1]!,
          "type it as { signal: AbortSignal }",
        );
      }
      const acLocal = lowerer.declareHiddenLocal("%duplexAbort", DYN);
      const ac = varRef(acLocal.id, DYN, loc);
      signalDecls = [
        {
          kind: "varDecl",
          localId: acLocal.id,
          init: { kind: "libCall", fn: "fetch.abortControllerNew", args: [], type: DYN, loc },
          loc,
        },
      ];
      signalArgs = [
        pipelineAbortHelper(lowerer, ac, loc, true),
        { kind: "dynKeyGet", value: ac, key: strLit("signal", loc), type: DYN, loc },
      ];
    }
    const withSignal = (fnName: IrLibFn, args: IrExpr[]): IrExpr => {
      const call: IrExpr = {
        kind: "libCall",
        fn: signalArgs.length > 0 ? (`${fnName}Signal` as IrLibFn) : fnName,
        args: [...args, ...signalArgs],
        type: duplex,
        loc,
      };
      return signalDecls.length > 0
        ? { kind: "seqExpr", stmts: signalDecls, result: call, type: duplex, loc }
        : call;
    };
    if (!isGen) {
      // an async function: a writable Duplexify whose final waits for
      // the function's promise
      const asyncSource = duplexSourceHelper(lowerer, sourceT, loc);
      const out = lowered.out;
      if (out.kind !== "promise" || !asyncSource)
        return lowerer.noLowering("Duplex.from over a function with this return type", node);
      if (
        out.inner.kind !== "void" &&
        !canConvertToDyn(
          out.inner,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        lowerer.noLowering(
          `Duplex.from over a function resolving to '${lowerer.fmt(out.inner)}'`,
          node,
        );
      }
      return withSignal("stream.duplexFromAsyncFn", [
        lowered.closure,
        asyncSource,
        pipelineBoxHelper(lowerer, out, loc),
      ]);
    }
    const helpers =
      lowered.out.kind === "generator" ? fromGenHelpers(lowerer, lowered.out, loc) : null;
    const source = duplexSourceHelper(lowerer, sourceT, loc);
    if (!helpers || !source)
      lowerer.noLowering("Duplex.from over a function with this generator type", node);
    return withSignal("stream.duplexFromGen", [lowered.closure, source!, ...helpers!]);
  }
  // duplexify.js: a stream answers itself (a Duplex) or is wrapped; any
  // other body reads as from(Duplexify, body, { objectMode: true,
  // writable: false })
  let bodyT: IrType | null;
  try {
    bodyT = lowerer.mapTypeOf(lowerer.typeOf(node));
  } catch {
    bodyT = null;
  }
  const bodySides =
    bodyT?.kind === "object" ? streamSidesOf(lowerer, lowerer.classes.get(bodyT.className)) : null;
  let literal: ts.Expression = node;
  while (ts.isParenthesizedExpression(literal)) literal = literal.expression;
  if (bodySides === null && ts.isObjectLiteralExpression(literal))
    return duplexFromPair(lowerer, literal, loc);
  if (bodyT?.kind === "promise") {
    // a Duplexify that reads the promise's value
    const valueT = bodyT.inner;
    if (
      valueT.kind !== "void" &&
      !canConvertToDyn(
        valueT,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      lowerer.noLowering(`Duplex.from over a promise of '${lowerer.fmt(valueT)}'`, node);
    }
    const promise = lowerer.lowerExpr(node);
    if (promise.type.kind !== "promise") {
      // a checked-dynamic promise (an untyped function's result)
      return {
        kind: "libCall",
        fn: "stream.duplexFromDyn",
        args: [lowerer.coerceToExpected(promise, DYN)],
        type: { kind: "object", className: "%Duplex" },
        loc,
      };
    }
    return {
      kind: "libCall",
      fn: "stream.duplexFromPromise",
      args: [
        promise,
        pipelineBoxHelper(lowerer, promise.type as IrType & { kind: "promise" }, loc),
      ],
      type: { kind: "object", className: "%Duplex" },
      loc,
    };
  }
  if (bodySides === null) return lowerFromSource(lowerer, node, node, undefined, true);
  let stream: IrExpr;
  try {
    stream = lowerStreamArg(lowerer, node, "compose");
  } catch (e) {
    if (e instanceof StreamArgTypeThrow) return e.expr;
    throw e;
  }
  const sides =
    stream.type.kind === "object"
      ? streamSidesOf(lowerer, lowerer.classes.get(stream.type.className))
      : null;
  // _duplexify({ readable }) / _duplexify({ writable })
  if (sides === "r" || sides === "w") {
    return {
      kind: "libCall",
      fn: sides === "r" ? "stream.duplexifyReadable" : "stream.duplexifyWritable",
      args: [stream],
      type: duplex,
      loc,
    };
  }
  if (sides !== "rw") {
    lowerer.noLowering(
      "Duplex.from over a value of this type",
      node,
      "an async generator function, an iterable, a stream, or a { readable, writable } pair is the lowered body",
    );
  }
  return stream;
}

/** Duplex.from({ readable, writable }): each member that is a stream with
 * that side is used as it is, any other member is Duplex.from of it, and
 * the pair reads and writes through _duplexify (duplexify.js). The
 * members evaluate in source order. */
function duplexFromPair(
  lowerer: Lowerer,
  literal: ts.ObjectLiteralExpression,
  loc: SrcLoc,
): IrExpr {
  const duplex: IrType = { kind: "object", className: "%Duplex" };
  const sides: { readable?: IrExpr; writable?: IrExpr } = {};
  // The members in source order; when that is not (readable, writable),
  // each value is bound to a local first, keeping the literal's
  // evaluation order.
  const members: { key: "readable" | "writable"; value: IrExpr }[] = [];
  for (const p of literal.properties.nodes) {
    const key =
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)
        ? p.name.text
        : null;
    if (key !== "readable" && key !== "writable") {
      lowerer.noLowering(
        "Duplex.from over an object with members other than readable and writable",
        p,
        "pass { readable, writable } with streams or Duplex.from bodies",
      );
    }
    const value = ts.isShorthandPropertyAssignment(p)
      ? (p.name as ts.Identifier)
      : (p as ts.PropertyAssignment).initializer;
    let valueT: IrType | null;
    try {
      valueT = lowerer.mapTypeOf(lowerer.typeOf(value));
    } catch {
      valueT = null;
    }
    const valueSides =
      valueT?.kind === "object"
        ? streamSidesOf(lowerer, lowerer.classes.get(valueT.className))
        : null;
    const wanted = key === "readable" ? "r" : "w";
    const direct = valueSides === "rw" || valueSides === wanted;
    members.push({
      key: key!,
      value: direct
        ? lowerStreamArg(lowerer, value, "compose")
        : duplexFromBody(lowerer, value, loc),
    });
  }
  const decls: IrStmt[] = [];
  const inOrder =
    members.length <= 1 ||
    (members.length === 2 && members[0]!.key === "readable" && members[1]!.key === "writable");
  for (const m of members) {
    if (inOrder) {
      sides[m.key] = m.value;
      continue;
    }
    const local = lowerer.declareHiddenLocal(`%duplex${m.key}`, m.value.type);
    decls.push({ kind: "varDecl", localId: local.id, init: m.value, loc });
    sides[m.key] = varRef(local.id, m.value.type, loc);
  }
  const { readable, writable } = sides;
  if (readable && writable) {
    const call: IrExpr = {
      kind: "libCall",
      fn: "stream.duplexifyPair",
      args: [readable, writable],
      type: duplex,
      loc,
    };
    return decls.length > 0
      ? { kind: "seqExpr", stmts: decls, result: call, type: duplex, loc }
      : call;
  }
  if (decls.length > 0) {
    // a repeated member: every value is evaluated, the last one is used
    const one = readable ?? writable!;
    const call: IrExpr = {
      kind: "libCall",
      fn: readable ? "stream.duplexifyReadable" : "stream.duplexifyWritable",
      args: [one],
      type: duplex,
      loc,
    };
    return { kind: "seqExpr", stmts: decls, result: call, type: duplex, loc };
  }
  if (readable)
    return { kind: "libCall", fn: "stream.duplexifyReadable", args: [readable], type: duplex, loc };
  if (writable)
    return { kind: "libCall", fn: "stream.duplexifyWritable", args: [writable], type: duplex, loc };
  return lowerer.noLowering(
    "Duplex.from over an object with neither readable nor writable",
    literal,
    "pass { readable, writable } with streams or Duplex.from bodies",
  );
}

/** The checker type of a stage's string or Buffer chunks, or null for
 * other chunk types. */
function stageChunkCheckerType(lowerer: Lowerer, chunk: IrType, at: ts.Node): ts.Type | null {
  if (chunk.kind === "string") return lowerer.checker.getStringType();
  if (chunk.kind !== "bytes") return null;
  const buffer = lowerer.checker.resolveName("Buffer", ts.SymbolFlags.Type, at, false);
  return buffer ? lowerer.checker.getDeclaredTypeOfSymbol(buffer) : null;
}

/** `stream.compose(...streams)` over stream instances: a Duplex writing
 * to the first stream and reading from the last (scr_stream_compose). The
 * classes fix which positions can be readable and writable; a stream in
 * the wrong position, a single Readable or Writable (Duplex.from wraps
 * those), and functions, iterables or web streams have no lowering. */
function lowerStreamCompose(lowerer: Lowerer, args: readonly ts.Expression[], loc: SrcLoc): IrExpr {
  const duplex: IrType = { kind: "object", className: "%Duplex" };
  if (args.length === 0) {
    return nodeThrowExpr(
      1,
      "ERR_MISSING_ARGS",
      'The "streams" argument must be specified',
      duplex,
      loc,
    );
  }
  // A web ReadableStream first stage reads as an async iterable (the
  // pipeline's source), and alone it is Duplex.from of it; a later stage
  // would be Duplex.fromWeb of it.
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    // (typeOf on a stage function's name would report what collecting its
    // declared signature deferred)
    if (pipelineStageFunction(lowerer, a) !== null) continue;
    if (staticReadableStreamElementType(lowerer, a) !== null) {
      lowerer.noLowering(
        "compose with a web ReadableStream after the first stage",
        a,
        "a web ReadableStream is supported as the first stage of compose or pipeline, and in Readable.from",
      );
    }
  }
  // Duplex.from(stage) for one stage (duplexify.js), and for a function at
  // either end; functions between, an iterable first stage or a source
  // function run as the pipeline's function stages (compose.js)
  if (args.length === 1) return duplexFromBody(lowerer, args[0]!, loc);
  const last = args.length - 1;
  const isFn = (i: number): boolean => pipelineStageFunction(lowerer, args[i]!) !== null;
  const pre = new Map<number, IrExpr>();
  if (isFn(0)) pre.set(0, duplexFromBody(lowerer, args[0]!, loc));
  if (isFn(last)) pre.set(last, duplexFromBody(lowerer, args[last]!, loc));
  const staged =
    args.some((_, i) => !pre.has(i) && isFn(i)) ||
    (!pre.has(0) && iterableSourceType(lowerer, args[0]!) !== null);
  if (staged) {
    const lowered = lowerPipelineStages(lowerer, args, loc, pre);
    return lowered.wrap({
      kind: "libCall",
      fn: "stream.composeStages",
      args: lowered.args,
      type: duplex,
      loc,
    });
  }
  let streams: IrExpr[];
  try {
    streams = args.map((a, i) => pre.get(i) ?? lowerStreamArg(lowerer, a, "compose"));
  } catch (e) {
    if (e instanceof StreamArgTypeThrow) return e.expr;
    throw e;
  }
  const sides = streams.map((s) =>
    s.type.kind === "object" ? streamSidesOf(lowerer, lowerer.classes.get(s.type.className)) : null,
  );
  if (streams.length === 1) {
    // Duplex.from answers a duplex itself.
    if (sides[0] === "rw") return streams[0]!;
    lowerer.noLowering(
      `compose of a single ${sides[0] === "r" ? "Readable" : "Writable"}`,
      args[0]!,
      "Duplex.from wraps a lone Readable or Writable, which has no lowering yet; one Duplex, Transform or PassThrough answers itself",
    );
  }
  for (let i = 0; i < streams.length; i++) {
    const s = sides[i];
    const want =
      i < streams.length - 1 && s === "w" ? "readable" : i > 0 && s === "r" ? "writable" : null;
    if (want) {
      lowerer.noLowering(
        `compose with a stream that is not ${want} at position ${i}`,
        args[i]!,
        `Node throws ERR_INVALID_ARG_VALUE ('streams[${i}]' must be ${want}); every stream but the last must be readable and every stream but the first writable`,
      );
    }
  }
  return {
    kind: "libCall",
    fn: "stream.compose",
    args: [numLit(streams.length, loc), ...streams],
    type: duplex,
    loc,
  };
}

/* ── the method surface ───────────────────────────────────────────────── */

/* ── the Readable operators ──────────────────────────────────────────── */

/** The Readable operators (scr_stream_ops.c — Node's operators.js). */
/** A stream member's receiver, lowered: a value the checker types as a
 * stream class whose lowering is checked-dynamic (a JavaScript binding
 * that holds an untyped call's result) or a union (an element read)
 * converts to that class, checked where the member runs. */
function streamReceiverExpr(lowerer: Lowerer, node: ts.Expression): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (value.type.kind !== "dyn" && value.type.kind !== "union") return value;
  let classT: IrType | null;
  try {
    classT = lowerer.mapTypeOf(lowerer.typeOf(node));
  } catch {
    return value;
  }
  if (
    classT?.kind !== "object" ||
    streamSidesOf(lowerer, lowerer.classes.get(classT.className)) === null
  )
    return value;
  return value.type.kind === "dyn"
    ? { kind: "dynCheck", value, type: classT, loc: value.loc }
    : lowerer.coerceToExpected(value, classT);
}

export const STREAM_OPERATORS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "flatMap",
  "drop",
  "take",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
  "reduce",
]);

/** An operator callback as a checked-dynamic function value, and whether
 * it declares the options argument ({ signal }), which the runtime then
 * passes. Its results convert to checked-dynamic values (flatMap's are
 * iterated with yield*). */
function lowerOperatorCallback(
  lowerer: Lowerer,
  node: ts.Expression,
  member: string,
  maxParams: number,
): { fn: IrExpr; takesOptions: boolean; gen?: IrType & { kind: "generator" } } {
  const loc = locOf(node);
  const optionsParam = (at: ts.Node): never =>
    lowerer.noLowering(
      `${member} callbacks with parameters after the options argument`,
      at,
      "the callback takes the chunk and { signal }",
    );
  let takesOptions = false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (node.parameters.nodes.length > maxParams + 1)
      optionsParam(node.parameters.nodes[maxParams + 1]!);
    takesOptions = node.parameters.nodes.length > maxParams;
  }
  const v = lowerer.lowerExpr(node);
  // A checked-dynamic function's parameters are not known here: it gets
  // the { signal } argument, as Node passes it to every callback.
  if (v.type.kind === "dyn") return { fn: v, takesOptions: true };
  if (
    v.type.kind !== "func" &&
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    lowerer.dynConvertible(v.type)
  ) {
    // JavaScript passes any value; Node's validateFunction throws.
    return { fn: { kind: "dynFrom", value: v, type: DYN, loc }, takesOptions: false };
  }
  if (v.type.kind !== "func") {
    lowerer.noLowering(
      `${member} with a '${lowerer.fmt(v.type)}' callback`,
      node,
      "pass a function",
    );
  }
  if (v.type.params.length > maxParams + 1) optionsParam(node);
  if (v.type.params.length > maxParams) takesOptions = true;
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  if (!canBoxFuncIntoDyn(v.type, getRecord, getUnion)) {
    lowerer.noLowering(
      `${member} with this callback`,
      node,
      "the callback's parameter and result types must cross the checked-dynamic boundary",
    );
  }
  const fn: IrExpr = { kind: "dynFrom", value: v, type: DYN, loc };
  // flatMap over a compiled generator: the runtime steps it through the
  // helpers over its type
  if (member === "flatMap" && v.type.ret.kind === "generator")
    return { fn, takesOptions, gen: v.type.ret };
  return { fn, takesOptions };
}

/** The operator callbacks' `{ signal }` (operators.js): map and the
 * operators over it pass `{ signal: AbortSignal.any([options?.signal]
 * .filter(Boolean)) }`. options is the operator's options value. */
export function operatorSignalOptions(lowerer: Lowerer, options: IrExpr, loc: SrcLoc): IrExpr {
  void lowerer;
  const list: IrExpr = {
    kind: "libCall",
    fn: "readable.opSignalList",
    args: [options],
    type: DYN,
    loc,
  };
  const signal: IrExpr = { kind: "libCall", fn: "fetch.abortAny", args: [list], type: DYN, loc };
  return { kind: "libCall", fn: "readable.opSignalOpts", args: [signal], type: DYN, loc };
}

/** reduce's signal for a reducer that reads it (operators.js): `const ac
 * = new AbortController()`, `options.signal.addEventListener('abort', ()
 * => ac.abort(), { once: true })`, then reduceSignal's ac.abort() closure
 * and `{ signal: ac.signal }`. options is the bound options value. */
export function reduceSignalSetup(
  lowerer: Lowerer,
  options: IrExpr,
  loc: SrcLoc,
  declare: (name: string, type: IrType) => IrLocal = (name, type) =>
    lowerer.declareHiddenLocal(name, type),
): { stmts: IrStmt[]; abort: IrExpr; cbOpts: IrExpr } {
  const acLocal = declare("%opAbort", DYN);
  const ac = varRef(acLocal.id, DYN, loc);
  const sigLocal = declare("%opUserSignal", DYN);
  const sig = varRef(sigLocal.id, DYN, loc);
  const abort = pipelineAbortHelper(lowerer, ac, loc);
  const stmts: IrStmt[] = [
    {
      kind: "varDecl",
      localId: acLocal.id,
      init: { kind: "libCall", fn: "fetch.abortControllerNew", args: [], type: DYN, loc },
      loc,
    },
    {
      kind: "varDecl",
      localId: sigLocal.id,
      init: { kind: "libCall", fn: "readable.opSignalOf", args: [options], type: DYN, loc },
      loc,
    },
    {
      kind: "if",
      cond: { kind: "dynTest", test: "truthy", value: sig, type: BOOL, loc },
      then: [
        {
          kind: "exprStmt",
          expr: {
            kind: "dynInvoke",
            recv: sig,
            method: "addEventListener",
            calleeName: "options.signal.addEventListener",
            args: [
              { kind: "dynFrom", value: strLit("abort", loc), type: DYN, loc },
              { kind: "dynFrom", value: pipelineAbortHelper(lowerer, ac, loc), type: DYN, loc },
              { kind: "libCall", fn: "readable.opOnceOptions", args: [], type: DYN, loc },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      else_: null,
      loc,
    },
  ];
  const signal: IrExpr = {
    kind: "dynKeyGet",
    value: ac,
    key: strLit("signal", loc),
    type: DYN,
    loc,
  };
  return {
    stmts,
    abort,
    cbOpts: { kind: "libCall", fn: "readable.opSignalOpts", args: [signal], type: DYN, loc },
  };
}

/** An operator's options (or reduce's initial value): an object literal
 * becomes a checked-dynamic object, checked-dynamic values pass through,
 * absent arguments are undefined. */
function lowerOperatorValue(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  what: string,
  loc: SrcLoc,
  literalObject: boolean,
): IrExpr {
  if (node === undefined) return dynUndefinedExpr(loc);
  if (literalObject && ts.isObjectLiteralExpression(node))
    return lowerDynObjectLiteral(lowerer, node);
  const v = lowerer.lowerExpr(node);
  if (v.type.kind === "dyn") return v;
  if (literalObject && v.type.kind !== "undefinedT" && v.type.kind !== "nullT") {
    lowerer.noLowering(
      `${what} that are not an object literal`,
      node,
      "write the options inline, e.g. { concurrency: 2 }",
    );
  }
  if (!lowerer.dynConvertible(v.type)) {
    lowerer.noLowering(`${what} of type '${lowerer.fmt(v.type)}'`, node);
  }
  return { kind: "dynFrom", value: v, type: DYN, loc: locOf(node) };
}

function lowerStreamOperator(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  member: string,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  // JS order: the receiver, the callback, then the options; the
  // callback's { signal } is built over the options value afterwards.
  const decls: IrStmt[] = [];
  const bind = (value: IrExpr, name: string): IrExpr => {
    const local = lowerer.declareHiddenLocal(name, value.type);
    decls.push({ kind: "varDecl", localId: local.id, init: value, loc });
    return varRef(local.id, value.type, loc);
  };
  const recv = bind(streamReceiverExpr(lowerer, access.expression), "%opRecv");
  const readable: IrType = { kind: "object", className: "%Readable" };
  const opts = (i: number): IrExpr =>
    lowerOperatorValue(lowerer, args[i], `${member} options`, loc, true);
  let takesOptions = false;
  let callbackGen: (IrType & { kind: "generator" }) | undefined;
  const fnArg = (maxParams: number): IrExpr => {
    if (args[0] === undefined) return dynUndefinedExpr(loc);
    const lowered = lowerOperatorCallback(lowerer, args[0], member, maxParams);
    takesOptions = lowered.takesOptions;
    callbackGen = lowered.gen;
    return bind(lowered.fn, "%opFn");
  };
  const lib = (fn: string, a: IrExpr[], type: IrType): IrExpr => {
    const call: IrExpr = { kind: "libCall", fn: fn as IrLibFn, args: a, type, loc };
    return { kind: "seqExpr", stmts: decls, result: call, type, loc };
  };
  // the options argument (bound), and the callback's { signal } when it
  // declares one
  const withSignal = (optsValue: IrExpr): IrExpr[] => {
    const o = bind(optsValue, "%opOptions");
    return [o, takesOptions ? operatorSignalOptions(lowerer, o, loc) : dynUndefinedExpr(loc)];
  };
  switch (member) {
    case "map":
    case "filter":
    case "flatMap": {
      const fn = fnArg(1);
      const fnName =
        member === "map"
          ? "readable.opMap"
          : member === "filter"
            ? "readable.opFilter"
            : "readable.opFlatMap";
      const rest = withSignal(opts(1));
      const genHelpers = callbackGen ? fromGenHelpers(lowerer, callbackGen, loc) : null;
      if (callbackGen && genHelpers) {
        return lib(
          callbackGen.async ? "readable.opFlatMapAsyncGen" : "readable.opFlatMapSyncGen",
          [recv, fn, ...rest, ...genHelpers],
          readable,
        );
      }
      return lib(fnName, [recv, fn, ...rest], readable);
    }
    case "drop":
    case "take": {
      const n = lowerOperatorValue(lowerer, args[0], `${member}'s count`, loc, false);
      return lib(
        member === "drop" ? "readable.opDrop" : "readable.opTake",
        [recv, n, opts(1)],
        readable,
      );
    }
    case "toArray":
      return lib("readable.opToArray", [recv, opts(0)], { kind: "promise", inner: DYN });
    case "forEach": {
      const fn = fnArg(1);
      return lib("readable.opForEach", [recv, fn, ...withSignal(opts(1))], {
        kind: "promise",
        inner: VOID,
      });
    }
    case "some":
    case "every": {
      const fn = fnArg(1);
      return lib(
        member === "some" ? "readable.opSome" : "readable.opEvery",
        [recv, fn, ...withSignal(opts(1))],
        {
          kind: "promise",
          inner: BOOL,
        },
      );
    }
    case "find": {
      const t = lowerer.typeOf(call);
      const inner = lowerer.checker.getTypeArguments(t as ts.TypeReference)[0];
      if (inner && !(inner.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        lowerer.noLowering(
          "find with a type-guard callback",
          call,
          "the result is a checked-dynamic value — use a boolean predicate and narrow the result",
        );
      }
      const fn = fnArg(1);
      return lib("readable.opFind", [recv, fn, ...withSignal(opts(1))], {
        kind: "promise",
        inner: DYN,
      });
    }
    case "reduce": {
      const t = lowerer.typeOf(call);
      const resultTs = lowerer.checker.getTypeArguments(t as ts.TypeReference)[0];
      let kind = 0;
      let inner: IrType = DYN;
      if (resultTs && !(resultTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        const mapped = lowerer.mapTypeOf(resultTs);
        if (mapped?.kind === "f64") {
          kind = 1;
          inner = F64;
        } else if (mapped?.kind === "bool") {
          kind = 2;
          inner = BOOL;
        } else if (mapped?.kind === "string") {
          kind = 3;
          inner = STRING;
        } else if (mapped?.kind !== "dyn") {
          lowerer.noLowering(
            `reduce with a '${mapped ? lowerer.fmt(mapped) : lowerer.checker.typeToString(resultTs)}' result`,
            call,
            "reduce results are numbers, booleans, strings, or checked-dynamic values",
          );
        }
      }
      const fn = fnArg(2);
      const init = bind(
        lowerOperatorValue(lowerer, args[1], "reduce's initial value", loc, false),
        "%opInit",
      );
      const o = bind(opts(2), "%opOptions");
      const head = [recv, fn, init, boolLit(args.length >= 2, loc), o, numLit(kind, loc)];
      if (!takesOptions) return lib("readable.opReduce", head, { kind: "promise", inner });
      const setup = reduceSignalSetup(lowerer, o, loc);
      decls.push(...setup.stmts);
      return lib("readable.opReduceSignal", [...head, setup.abort, setup.cbOpts], {
        kind: "promise",
        inner,
      });
    }
  }
  throw new InternalCompilerError(`unknown stream operator ${member}`);
}

/** The one supported encoding argument: utf8 (Node's default), as a
 * compile-time literal or absent. */
function checkUtf8Encoding(lowerer: Lowerer, member: string, arg: ts.Expression | undefined): void {
  if (arg === undefined) return;
  const t = lowerer.typeOf(arg);
  if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) return;
  lowerer.noLowering(
    `${member} with a ${t.isStringLiteralType() ? `'${t.value}'` : "non-literal"} encoding`,
    arg,
    "utf8 (as a compile-time literal) is the supported encoding",
  );
}

/** `recv.<member>(...)` over a stream-rooted receiver. Returns null only
 * for members this spoke does not own. */
/** pipe()'s `{ end }` option: true when absent. */
function pipeEndOption(lowerer: Lowerer, options: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  let end: IrExpr = boolLit(true, loc);
  if (options === undefined) return end;
  if (!ts.isObjectLiteralExpression(options)) {
    lowerer.noLowering(
      "pipe with a non-literal options argument",
      options,
      "{ end: <bool> } inline is the supported form",
    );
  }
  for (const prop of options.properties.nodes) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== "end") {
      lowerer.noLowering("a pipe option other than 'end'", prop);
    }
    end = lowerer.lowerExprExpecting(prop.initializer, BOOL);
  }
  return end;
}

/** `readable.pipe(process.stdout)`: the process stream joins the pipe as
 * an fd-backed Writable (stream.stdioWritable), and — like Node, which
 * never ends process.stdout or process.stderr from a pipe — the source's
 * end does not end it. pipe() answers the process stream itself. */
function pipeIntoStdio(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  target: IrExpr,
): IrExpr {
  const loc = locOf(call);
  // JS order: the receiver, then the destination, then the options.
  const receiverValue = streamReceiverExpr(lowerer, access.expression);
  const source = lowerer.declareHiddenLocal("%pipeSource", receiverValue.type);
  const stdio = lowerer.declareHiddenLocal("%pipeStdio", target.type);
  const options = call.arguments.nodes[1];
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: source.id, init: receiverValue, loc },
    { kind: "varDecl", localId: stdio.id, init: target, loc },
  ];
  // The options literal still evaluates; its end flag has no effect here.
  if (options !== undefined) {
    stmts.push({ kind: "exprStmt", expr: pipeEndOption(lowerer, options, loc), loc });
  }
  const receiver: IrExpr = { kind: "varRef", localId: source.id, type: receiverValue.type, loc };
  const writable: IrType = { kind: "object", className: "%Writable" };
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "readable.pipe",
      args: [
        receiver,
        {
          kind: "libCall",
          fn: "stream.stdioWritable",
          args: [{ kind: "varRef", localId: stdio.id, type: target.type, loc }],
          type: writable,
          loc,
        },
        boolLit(false, loc),
      ],
      type: writable,
      loc,
    },
    loc,
  });
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "varRef", localId: stdio.id, type: target.type, loc },
    type: target.type,
    loc,
  };
}

/** `readable.unpipe(untyped)`: a native destination (boxed) unpipes as a
 * typed one does; any other value unpipes the JavaScript destination a
 * pipe into it registered (scr_stream_dyn.c), or does nothing when there
 * is none, as Node's unpipe does for a destination it is not piped into.
 * The call answers the source. */
function unpipeDyn(lowerer: Lowerer, receiver: IrExpr, dst: IrExpr, loc: SrcLoc): IrExpr {
  noteUntypedStreamFlow(lowerer, null);
  const source = lowerer.declareHiddenLocal("%unpipeSource", receiver.type);
  const destination = lowerer.declareHiddenLocal("%unpipeDestination", dst.type);
  const sourceRef = varRef(source.id, receiver.type, loc);
  const destinationRef = varRef(destination.id, dst.type, loc);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: source.id, init: receiver, loc },
    { kind: "varDecl", localId: destination.id, init: dst, loc },
  ];
  const unpipeNative = (native: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "readable.unpipe",
      args: [sourceRef, native],
      type: receiver.type,
      loc,
    },
    loc,
  });
  if (lowerer.dynNodeStreams) {
    stmts.push(
      dynNativeBranch(lowerer, destinationRef, "w", unpipeNative, {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "stream.unpipeDyn",
          args: [sourceRef, destinationRef],
          type: VOID,
          loc,
        },
        loc,
      }),
    );
  } else {
    stmts.push(
      unpipeNative({
        kind: "libCall",
        fn: "stream.unboxDyn",
        args: [
          destinationRef,
          strLit("unpipe destinations other than native streams are not supported yet", loc),
        ],
        type: { kind: "object", className: "%Duplex" },
        loc,
      }),
    );
  }
  return { kind: "seqExpr", stmts, result: sourceRef, type: receiver.type, loc };
}

/** The pipe() libCall for a destination of type `dst`. Under the general
 * stream representation a Writable slot can hold the converted
 * process.stdout / process.stderr, which a pipe never ends (as in Node), so
 * the pipe takes readable.pipeGeneral, which checks for them. */
function generalPipe(lowerer: Lowerer, dst: IrType): "readable.pipe" | "readable.pipeGeneral" {
  return lowerer.generalNodeStreams && dst.kind === "object" && dst.className === "%Writable"
    ? "readable.pipeGeneral"
    : "readable.pipe";
}

/** `readable.pipe(untyped)`: a checked-dynamic destination unwraps a boxed
 * native stream at run time (stream.unboxDyn; other values throw the
 * not-supported Error), and pipe() answers the destination value itself. */
function pipeIntoDyn(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  target: IrExpr,
): IrExpr {
  const loc = locOf(call);
  noteUntypedStreamFlow(lowerer, null);
  const receiverValue = streamReceiverExpr(lowerer, access.expression);
  const source = lowerer.declareHiddenLocal("%pipeSource", receiverValue.type);
  const destination = lowerer.declareHiddenLocal("%pipeDestination", target.type);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: source.id, init: receiverValue, loc },
    { kind: "varDecl", localId: destination.id, init: target, loc },
  ];
  const end = pipeEndOption(lowerer, call.arguments.nodes[1], loc);
  const duplex: IrType = { kind: "object", className: "%Duplex" };
  // Checked-dynamic stream slots (dyn-streams.ts): a JavaScript stream
  // object is a destination too, piped with Node's listener protocol.
  if (lowerer.dynNodeStreams) {
    const sourceRef: IrExpr = { kind: "varRef", localId: source.id, type: receiverValue.type, loc };
    const destinationRef: IrExpr = {
      kind: "varRef",
      localId: destination.id,
      type: target.type,
      loc,
    };
    const ending = lowerer.declareHiddenLocal("%pipeEnd", BOOL);
    stmts.push({ kind: "varDecl", localId: ending.id, init: end, loc });
    const endRef: IrExpr = { kind: "varRef", localId: ending.id, type: BOOL, loc };
    stmts.push(
      dynNativeBranch(
        lowerer,
        destinationRef,
        "w",
        (native) => ({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            // Checked-dynamic slots come with the general representation,
            // where a boxed native destination can be the converted
            // process.stdout (generalPipe).
            fn: "readable.pipeGeneral",
            args: [sourceRef, native, endRef],
            type: native.type,
            loc,
          },
          loc,
        }),
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "stream.pipeDyn",
            args: [sourceRef, lowerer.coerceToExpected(sourceRef, DYN), destinationRef, endRef],
            type: VOID,
            loc,
          },
          loc,
        },
      ),
    );
    return {
      kind: "seqExpr",
      stmts,
      result: destinationRef,
      type: target.type,
      loc,
    };
  }
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: lowerer.generalNodeStreams ? "readable.pipeGeneral" : "readable.pipe",
      args: [
        { kind: "varRef", localId: source.id, type: receiverValue.type, loc },
        {
          kind: "libCall",
          fn: "stream.unboxDyn",
          args: [
            { kind: "varRef", localId: destination.id, type: target.type, loc },
            strLit("pipe destinations other than native streams are not supported yet", loc),
          ],
          type: duplex,
          loc,
        },
        end,
      ],
      type: duplex,
      loc,
    },
    loc,
  });
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "varRef", localId: destination.id, type: target.type, loc },
    type: target.type,
    loc,
  };
}

/** readable.compose(stage, options): compose(this, stage), with
 * addAbortSignal(options.signal, composed) when the signal is set
 * (operators.js). */
function lowerReadableCompose(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  if (args.length === 0 || args.length > 2 || args.some((a) => ts.isSpreadElement(a))) {
    lowerer.noLowering(
      `readable.compose with ${args.length === 0 ? "no stage" : "these arguments"}`,
      call,
      "the supported form is readable.compose(stage) or readable.compose(stage, { signal })",
    );
  }
  let signalNode: ts.Expression | null = null;
  const options = args[1];
  if (
    options !== undefined &&
    options.kind !== ts.SyntaxKind.NullKeyword &&
    !(ts.isIdentifier(options) && options.text === "undefined")
  ) {
    if (!ts.isObjectLiteralExpression(options)) {
      lowerer.noLowering(
        "readable.compose options that are not an object literal",
        options,
        "pass { signal } as an object literal",
      );
    }
    for (const p of options.properties.nodes) {
      const key =
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name)
          ? p.name.text
          : null;
      if (key !== "signal") {
        lowerer.noLowering(
          key === null
            ? "readable.compose options with this member"
            : `the readable.compose option '${key}'`,
          p,
          "signal is the readable.compose option",
        );
      }
      const value = ts.isShorthandPropertyAssignment(p)
        ? (p.name as ts.Identifier)
        : (p as ts.PropertyAssignment).initializer;
      if (value.kind === ts.SyntaxKind.NullKeyword) continue;
      if (ts.isIdentifier(value) && value.text === "undefined") continue;
      // The signal is read after compose runs, so only values whose
      // evaluation has no effects.
      if (!sideEffectFreeOptionValue(value) && !pureRead(value)) {
        lowerer.noLowering(
          "the readable.compose option 'signal' with this value",
          p,
          "pass a variable or property read (const signal = controller.signal)",
        );
      }
      signalNode = value;
    }
  }
  const composed = lowerStreamCompose(lowerer, [access.expression, args[0]!], loc);
  if (signalNode === null) return composed;
  return {
    kind: "libCall",
    fn: "stream.addAbortSignal",
    args: [composed, lowerer.lowerExprExpecting(signalNode, DYN)],
    type: composed.type,
    loc,
  };
}

export function lowerStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
  const member = access.name.text;
  if (STREAM_OPERATORS.has(member)) {
    const opSides = streamSidesOf(lowerer, info);
    if (opSides === "r" || opSides === "rw")
      return lowerStreamOperator(lowerer, call, access, member);
  }
  if (member === "compose") {
    const composeSides = streamSidesOf(lowerer, info);
    return composeSides === "r" || composeSides === "rw"
      ? lowerReadableCompose(lowerer, call, access)
      : null;
  }
  if (!STREAM_API_MEMBERS.has(member)) return null;
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const readableSide = sides === "r" || sides === "rw";
  const writableSide = sides === "w" || sides === "rw";
  const cls = info.def.name.slice(1);

  const requireSide = (need: boolean, what: string): void => {
    if (!need) {
      lowerer.noLowering(
        `${what} on a ${cls} (the ${what.startsWith("write") || what === "end" || what === "cork" || what === "uncork" ? "writable" : "readable"} half is absent)`,
        call,
      );
    }
  };

  // Chunk classification for push/unshift/write/end. Union-typed chunks
  // over {Buffer, string, null} dispatch by tag at runtime — the
  // `push(more ? next : null)` idiom.
  const chunkKind = (node: ts.Expression): "bytes" | "string" | "null" | "union" | "dyn" => {
    if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
    const t = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (t?.kind === "bytes" && t.elem === "u8") return "bytes";
    if (t?.kind === "string") return "string";
    if (t?.kind === "nullT") return "null";
    if (t?.kind === "dyn") {
      // The JS lane's any-typed chunk: the runtime dispatches by dyn tag
      // (bytes / string / null; anything else is the write TypeError).
      return "dyn";
    }
    if (t?.kind === "union") {
      const def = lowerer.unions.get(t.unionId);
      if (
        def &&
        def.arms.every(
          (a) =>
            (a.kind === "bytes" && a.elem === "u8") || a.kind === "string" || a.kind === "nullT",
        )
      ) {
        return "union";
      }
    }
    if (t === null) {
      // A checker-untyped chunk (the JS lane's `t.write(x.toString())`
      // shapes): the LOWERING may still land on a supported kind — probe
      // it (the probe's IR is discarded; the caller re-lowers the node).
      const probed = tryLowerExpression(lowerer, node);
      if (probed?.type.kind === "string") return "string";
      if (probed?.type.kind === "bytes" && probed.type.elem === "u8") return "bytes";
      if (probed?.type.kind === "dyn") return "dyn";
      if (probed?.type.kind === "nullT") return "null";
    }
    // Any other value is a checked-dynamic chunk: one entry on an
    // object-mode side, Node's chunk type error on a byte-mode one
    // (undefined, which a byte-mode push ignores, included).
    if (t?.kind === "void" || t?.kind === "undefinedT") return "dyn";
    if (
      t !== null &&
      t.kind !== "func" &&
      canConvertToDyn(
        t,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      return "dyn";
    lowerer.noLowering(
      `${member} with a '${t ? lowerer.fmt(t) : "?"}' chunk`,
      node,
      "chunks are values that convert to checked-dynamic values: Buffers, strings, numbers, records, arrays and class instances",
    );
  };

  if (member === "push" || member === "unshift") {
    requireSide(readableSide, member);
    if (args.length === 0 || args.length > 2) {
      lowerer.noLowering(
        `${member} with ${args.length} arguments`,
        call,
        'the supported forms are (chunk) and (chunk, "utf8")',
      );
    }
    // push(chunk, enc) with a LITERAL encoding: the per-call decode
    // (Buffer.from(chunk, enc)) — an explicit encoding (utf8 included)
    // overrides the stream's defaultEncoding; unknown literals throw
    // Node's ERR_UNKNOWN_ENCODING when the push evaluates. unshift keeps
    // the utf8-only fence below.
    if (member === "push" && args[1] !== undefined && chunkKind(args[0]!) === "string") {
      const t = lowerer.typeOf(args[1]!);
      if (t.isStringLiteralType()) {
        const canonical = knownBufEncoding(t.value);
        if (canonical === undefined) {
          return nodeThrowExpr(
            1,
            "ERR_UNKNOWN_ENCODING",
            `Unknown encoding: ${t.value}`,
            BOOL,
            loc,
          );
        }
        const receiver = streamReceiverExpr(lowerer, access.expression);
        const chunk = lowerer.lowerExprExpecting(args[0]!, STRING);
        return {
          kind: "libCall",
          fn: "readable.pushStrEnc",
          args: [receiver, chunk, strLit(canonical, loc)],
          type: BOOL,
          loc,
        };
      }
    }
    checkUtf8Encoding(lowerer, member, args[1]);
    const kind = chunkKind(args[0]!);
    if ((kind === "null" || kind === "union" || kind === "dyn") && member === "unshift") {
      // unshift(value): an object-mode stream's value at the front, null
      // the end of the stream, as Node's readableAddChunk takes them
      const receiver = streamReceiverExpr(lowerer, access.expression);
      const chunk = lowerer.lowerExprExpecting(args[0]!, DYN);
      return {
        kind: "libCall",
        fn: "readable.unshiftDyn",
        args: [receiver, chunk],
        type: VOID,
        loc,
      };
    }
    const receiver = streamReceiverExpr(lowerer, access.expression);
    if (kind === "null") {
      return { kind: "libCall", fn: "readable.pushNull", args: [receiver], type: BOOL, loc };
    }
    if (kind === "dyn") {
      const chunk = lowerer.lowerExprExpecting(args[0]!, DYN);
      return { kind: "libCall", fn: "readable.pushDyn", args: [receiver, chunk], type: BOOL, loc };
    }
    if (kind === "union") {
      // The lowered value may have collapsed to one arm (checker
      // narrowing) — re-dispatch on its IR type.
      const chunk = lowerer.lowerExpr(args[0]!);
      if (chunk.type.kind === "union") {
        return { kind: "libCall", fn: "readable.pushU", args: [receiver, chunk], type: BOOL, loc };
      }
      if (chunk.type.kind === "bytes") {
        return { kind: "libCall", fn: "readable.push", args: [receiver, chunk], type: BOOL, loc };
      }
      if (chunk.type.kind === "string") {
        return {
          kind: "libCall",
          fn: "readable.pushStr",
          args: [receiver, chunk],
          type: BOOL,
          loc,
        };
      }
      return { kind: "libCall", fn: "readable.pushNull", args: [receiver], type: BOOL, loc };
    }
    const chunk =
      kind === "bytes"
        ? lowerer.lowerExprExpecting(args[0]!, BYTES)
        : lowerer.lowerExprExpecting(args[0]!, STRING);
    const fn =
      member === "push"
        ? kind === "bytes"
          ? "readable.push"
          : "readable.pushStr"
        : kind === "bytes"
          ? "readable.unshift"
          : "readable.unshiftStr";
    return {
      kind: "libCall",
      fn,
      args: [receiver, chunk],
      type: member === "push" ? BOOL : VOID,
      loc,
    };
  }

  if (member === "read") {
    requireSide(readableSide, "read");
    if (args.length > 1) lowerer.noLowering(`read with ${args.length} arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    // JavaScript (and a result the declarations type as any) reads any
    // chunk: a Buffer, a string once encoded, or an object-mode value.
    const resultTs = lowerer.typeOf(call);
    if (
      isJsSourceFile(ts.getSourceFileOfNode(call)) ||
      (resultTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    ) {
      const sizeDyn = args[0] ? lowerer.lowerExprExpecting(args[0], DYN) : dynUndefinedExpr(loc);
      return {
        kind: "libCall",
        fn: "readable.readDyn",
        args: [receiver, sizeDyn],
        type: DYN,
        loc,
      };
    }
    const size = args[0] ? lowerer.lowerExprExpecting(args[0], F64) : numLit(-1, loc);
    const type: IrType = unionOf(lowerer, [BYTES, { kind: "nullT" }]);
    const read: IrExpr = {
      kind: "libCall",
      fn: "readable.read",
      args: [receiver, size],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, call);
  }

  if (member === "pause" || member === "resume") {
    requireSide(readableSide, member);
    if (args.length !== 0) lowerer.noLowering(`${member} with arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    return {
      kind: "libCall",
      fn: member === "pause" ? "readable.pause" : "readable.resume",
      args: [receiver],
      type: receiver.type,
      loc,
    };
  }

  if (member === "isPaused") {
    requireSide(readableSide, "isPaused");
    if (args.length !== 0) lowerer.noLowering(`isPaused with arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    return { kind: "libCall", fn: "readable.isPaused", args: [receiver], type: BOOL, loc };
  }

  if (member === "pipe") {
    requireSide(readableSide, "pipe");
    if (args.length === 0 || args.length > 2) {
      lowerer.noLowering(
        `pipe with ${args.length} arguments`,
        call,
        "the supported forms are (destination) and (destination, { end })",
      );
    }
    // A Hash, Hmac, Cipheriv or Decipheriv destination pipes into its
    // Transform, and pipe() answers the value itself (the receiver
    // evaluates first, as in JS).
    if (isValueStream(lowerer, args[0]!)) {
      const receiverValue = streamReceiverExpr(lowerer, access.expression);
      const source = lowerer.declareHiddenLocal("%pipeSource", receiverValue.type);
      const hashValue = lowerer.lowerExpr(args[0]!);
      const hash = lowerer.declareHiddenLocal("%pipeHash", hashValue.type);
      const end = pipeEndOption(lowerer, args[1], loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: source.id, init: receiverValue, loc },
          { kind: "varDecl", localId: hash.id, init: hashValue, loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "readable.pipe",
              args: [
                { kind: "varRef", localId: source.id, type: receiverValue.type, loc },
                valueStreamOf(
                  { kind: "varRef", localId: hash.id, type: hashValue.type, loc },
                  true,
                ),
                end,
              ],
              type: { kind: "object", className: "%Transform" },
              loc,
            },
            loc,
          },
        ],
        result: { kind: "varRef", localId: hash.id, type: hashValue.type, loc },
        type: hashValue.type,
        loc,
      };
    }
    const target = lowerer.lowerExpr(args[0]!);
    if (target.type.kind === "procStream") return pipeIntoStdio(lowerer, call, access, target);
    if (target.type.kind === "dyn") return pipeIntoDyn(lowerer, call, access, target);
    const dst = target;
    const dstInfo =
      dst.type.kind === "object" ? lowerer.classes.get(dst.type.className) : undefined;
    const dstSides = streamSidesOf(lowerer, dstInfo);
    if (dstSides !== "w" && dstSides !== "rw") {
      requestGeneralStreamSurface(lowerer, args[0]!);
      lowerer.noLowering(
        `pipe into a '${lowerer.fmt(dst.type)}'`,
        args[0]!,
        "the destination must be a stream Writable/Duplex, process.stdout or process.stderr (sockets are not pipe destinations yet)",
      );
    }
    const end = pipeEndOption(lowerer, args[1], loc);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    return {
      kind: "libCall",
      fn: generalPipe(lowerer, dst.type),
      args: [receiver, dst, end],
      type: dst.type,
      loc,
    };
  }

  if (member === "unpipe") {
    requireSide(readableSide, "unpipe");
    if (args.length > 1) lowerer.noLowering(`unpipe with ${args.length} arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    if (args[0] !== undefined) {
      const dst = lowerer.lowerExpr(args[0]);
      if (dst.type.kind === "dyn") return unpipeDyn(lowerer, receiver, dst, loc);
      const dstInfo =
        dst.type.kind === "object" ? lowerer.classes.get(dst.type.className) : undefined;
      const dstSides = streamSidesOf(lowerer, dstInfo);
      if (dstSides !== "w" && dstSides !== "rw") {
        lowerer.noLowering(`unpipe of a '${lowerer.fmt(dst.type)}'`, args[0]);
      }
      return {
        kind: "libCall",
        fn: "readable.unpipe",
        args: [receiver, dst],
        type: receiver.type,
        loc,
      };
    }
    // Checked-dynamic slots: unpipe() also unpipes the JavaScript
    // destinations stream.pipeDyn registered (stream.unpipeDyn with an
    // undefined destination), as Node's unpipe() empties every pipe.
    if (lowerer.dynNodeStreams) {
      const source = lowerer.declareHiddenLocal("%unpipeSource", receiver.type);
      const sourceRef = varRef(source.id, receiver.type, loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: source.id, init: receiver, loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "readable.unpipe",
              args: [sourceRef],
              type: receiver.type,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "stream.unpipeDyn",
              args: [sourceRef, dynUndefinedExpr(loc)],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        result: sourceRef,
        type: receiver.type,
        loc,
      };
    }
    return { kind: "libCall", fn: "readable.unpipe", args: [receiver], type: receiver.type, loc };
  }

  if (member === "destroy") {
    if (args.length > 1) lowerer.noLowering(`destroy with ${args.length} arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    if (args[0] !== undefined) {
      const err = lowerer.lowerExpr(args[0]);
      const rootsAtError = (t: IrType): boolean => {
        if (t.kind !== "object") return false;
        for (let c: ClassInfo | null = lowerer.classes.get(t.className) ?? null; c; c = c.base) {
          if (c.def.name === "%Error") return true;
        }
        return false;
      };
      if (!rootsAtError(err.type)) {
        lowerer.noLowering(
          `destroy with a '${lowerer.fmt(err.type)}' argument`,
          args[0],
          "the supported argument is an Error-hierarchy instance",
        );
      }
      return {
        kind: "libCall",
        fn: "stream.destroyErr",
        args: [receiver, lowerer.upcastTo(err, "%Error")],
        type: receiver.type,
        loc,
      };
    }
    return { kind: "libCall", fn: "stream.destroy", args: [receiver], type: receiver.type, loc };
  }

  if (member === "write") {
    requireSide(writableSide, "write");
    if (args.length === 0 || args.length > 3) {
      lowerer.noLowering(`write with ${args.length} arguments`, call);
    }
    const kind = chunkKind(args[0]!);
    if (kind === "null") lowerer.noLowering("write(null)", call, "end() finishes a writable");
    const lowerWriteCb = (cbArg: ts.Expression): IrExpr => {
      const cb = callbackDeclaresParameters(cbArg)
        ? null
        : lowerer.lowerExprExpecting(cbArg, funcOf([], VOID));
      if (cb === null || cb.type.kind !== "func" || cb.type.params.length > 0) {
        lowerer.noLowering(
          "write completion callbacks taking the error argument",
          cbArg,
          "() => void callbacks are supported (listen for 'error' to observe failures)",
        );
      }
      return cb!;
    };
    // write(chunk, encoding[, cb]), and write(value, cb): the encoding
    // argument reaches an object-mode side's _write as passed, null when
    // the callback took its place (a byte-mode side encodes a string
    // chunk with it).
    const writeEnc = (
      encArg: ts.Expression | undefined,
      cbArg: ts.Expression | undefined,
    ): IrExpr => {
      const receiver = streamReceiverExpr(lowerer, access.expression);
      const chunk = lowerer.lowerExprExpecting(args[0]!, DYN);
      const tail: IrExpr[] = [];
      if (encArg !== undefined) tail.push(lowerer.lowerExprExpecting(encArg, DYN));
      if (cbArg !== undefined) tail.push(lowerWriteCb(cbArg));
      const flags = (encArg !== undefined ? 1 : 0) | (cbArg !== undefined ? 2 : 0);
      return {
        kind: "libCall",
        fn: "writable.writeEnc",
        args: [receiver, numLit(flags, loc), chunk, ...tail],
        type: BOOL,
        loc,
      };
    };
    if (kind === "dyn") {
      if (args.length === 3) return writeEnc(args[1], args[2]);
      if (args.length === 2) {
        // Node's write takes a function there as the callback, anything
        // else as the encoding
        const t = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
        if (t?.kind === "func") return writeEnc(undefined, args[1]);
        if (t === null || t === undefined || t.kind === "dyn") {
          lowerer.noLowering(
            "write with a dynamic second argument",
            args[1]!,
            "pass an encoding string or a completion callback",
          );
        }
        return writeEnc(args[1], undefined);
      }
      const receiver = streamReceiverExpr(lowerer, access.expression);
      const chunk = lowerer.lowerExprExpecting(args[0]!, DYN);
      return { kind: "libCall", fn: "writable.writeDyn", args: [receiver, chunk], type: BOOL, loc };
    }
    if (kind === "union") {
      // Bytes/string arms dispatch at runtime; a null arm value throws
      // Node's ERR_STREAM_NULL_VALUES TypeError in the runtime. The
      // lowered value may have collapsed to one arm (checker narrowing) —
      // re-dispatch on its IR type.
      if (args.length > 1) lowerer.noLowering("write with a union chunk and more arguments", call);
      const receiver = streamReceiverExpr(lowerer, access.expression);
      const chunk = lowerer.lowerExpr(args[0]!);
      const fn =
        chunk.type.kind === "union"
          ? "writable.writeU"
          : chunk.type.kind === "string"
            ? "writable.writeStr"
            : "writable.write";
      if (chunk.type.kind === "nullT")
        lowerer.noLowering("write(null)", call, "end() finishes a writable");
      return { kind: "libCall", fn, args: [receiver, chunk], type: BOOL, loc };
    }
    // Disambiguate (chunk, cb?) vs (chunk, encoding, cb?) by the second
    // argument's static type. A write with an encoding runs through
    // writeEnc, whose runtime checks and applies it as Node's _write does.
    let cbArg: ts.Expression | undefined;
    if (args.length === 3) return writeEnc(args[1], args[2]);
    if (args.length === 2) {
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
      if (t?.kind === "string" || t?.kind === "nullT" || t?.kind === "undefinedT")
        return writeEnc(args[1], undefined);
      cbArg = args[1];
    }
    const receiver = streamReceiverExpr(lowerer, access.expression);
    const chunk =
      kind === "bytes"
        ? lowerer.lowerExprExpecting(args[0]!, BYTES)
        : lowerer.lowerExprExpecting(args[0]!, STRING);
    const fn = kind === "bytes" ? "writable.write" : "writable.writeStr";
    if (cbArg !== undefined) {
      const cb = lowerWriteCb(cbArg);
      return { kind: "libCall", fn, args: [receiver, chunk, cb], type: BOOL, loc };
    }
    return { kind: "libCall", fn, args: [receiver, chunk], type: BOOL, loc };
  }

  if (member === "end") {
    requireSide(writableSide, "end");
    if (args.length > 3) lowerer.noLowering(`end with ${args.length} arguments`, call);
    // Forms: (), (cb), (chunk), (chunk, cb), (chunk, encoding, cb).
    let chunkNode: ts.Expression | undefined;
    let cbArg: ts.Expression | undefined;
    let encNode: ts.Expression | undefined;
    if (args.length === 1) {
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
      if (t?.kind === "func") cbArg = args[0];
      else chunkNode = args[0];
    } else if (args.length === 2) {
      chunkNode = args[0];
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
      if (t?.kind === "string" || t?.kind === "nullT" || t?.kind === "undefinedT")
        encNode = args[1];
      else cbArg = args[1];
    } else if (args.length === 3) {
      chunkNode = args[0];
      encNode = args[1];
      cbArg = args[2];
    }
    const receiver = streamReceiverExpr(lowerer, access.expression);
    let flags = 0;
    const tail: IrExpr[] = [];
    if (chunkNode !== undefined) {
      // end(chunk, encoding[, cb]) writes the chunk with the encoding
      // argument as passed (flags 16), through the dyn write
      const kind = encNode !== undefined ? "dyn" : chunkKind(chunkNode);
      if (kind === "null" || kind === "union") lowerer.noLowering("end(null)", call);
      flags |= kind === "bytes" ? 1 : kind === "dyn" ? 8 : 2;
      tail.push(
        kind === "bytes"
          ? lowerer.lowerExprExpecting(chunkNode, BYTES)
          : kind === "dyn"
            ? lowerer.lowerExprExpecting(chunkNode, DYN)
            : lowerer.lowerExprExpecting(chunkNode, STRING),
      );
      if (encNode !== undefined) {
        flags |= 16;
        tail.push(lowerer.lowerExprExpecting(encNode, DYN));
      }
    }
    if (cbArg !== undefined) {
      const cb = callbackDeclaresParameters(cbArg)
        ? null
        : lowerer.lowerExprExpecting(cbArg, funcOf([], VOID));
      if (cb === null || cb.type.kind !== "func" || cb.type.params.length > 0) {
        lowerer.noLowering(
          "end callbacks with parameters",
          cbArg,
          "() => void callbacks are supported",
        );
      }
      flags |= 4;
      tail.push(cb);
    }
    return {
      kind: "libCall",
      fn: "writable.end",
      args: [receiver, numLit(flags, loc), ...tail],
      type: receiver.type,
      loc,
    };
  }

  if (member === "cork" || member === "uncork") {
    requireSide(writableSide, member);
    if (args.length !== 0) lowerer.noLowering(`${member} with arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    return {
      kind: "libCall",
      fn: member === "cork" ? "writable.cork" : "writable.uncork",
      args: [receiver],
      type: VOID,
      loc,
    };
  }

  if (member === "setEncoding") {
    requireSide(readableSide, "setEncoding");
    if (args.length !== 1) {
      lowerer.noLowering(
        `setEncoding with ${args.length} arguments`,
        call,
        "one literal encoding is the supported form",
      );
    }
    const enc = bufEncoding(lowerer, "setEncoding", args[0]!);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    return {
      kind: "libCall",
      fn: "readable.setEncoding",
      args: [receiver, strLit(enc, loc)],
      type: receiver.type,
      loc,
    };
  }

  if (member === "setDefaultEncoding") {
    // The write-side default: lowercased and validated (ERR_UNKNOWN_ENCODING,
    // thrown) at run time; answers the stream.
    requireSide(writableSide, "setDefaultEncoding");
    if (args.length > 1)
      lowerer.noLowering(`setDefaultEncoding with ${args.length} arguments`, call);
    const receiver = streamReceiverExpr(lowerer, access.expression);
    const enc = args[0] ? lowerer.lowerExprExpecting(args[0], DYN) : dynUndefinedExpr(loc);
    return {
      kind: "libCall",
      fn: "writable.setDefaultEncoding",
      args: [receiver, enc],
      type: receiver.type,
      loc,
    };
  }

  return null;
}

/* ── the internal-state read surface (_readableState/_writableState) ──── */

/** The `s._readableState.<name>` / `s._writableState.<name>` READS the
 * suite's asserts use: a read-only compat VIEW over the real runtime
 * state — each supported name maps onto a state field the runtime
 * actually keeps, so the answers cannot lie. Writes and the object-
 * valued members (pipes, awaitDrainWriters, buffered entries) keep
 * their fences. Node's `ending`/`ended` distinction inside end() and
 * the per-side errored slots collapse onto the shared fields here
 * (SEMANTICS.md). */
const RS_BOOL_PROPS: ReadonlySet<string> = new Set([
  "ended",
  "endEmitted",
  "destroyed",
  "errorEmitted",
  "emittedReadable",
  "needReadable",
  "reading",
  "readableListening",
  "resumeScheduled",
  "objectMode",
  "constructed",
  "closed",
]);
const RS_NUM_PROPS: ReadonlySet<string> = new Set(["length", "highWaterMark"]);
const WS_BOOL_PROPS: ReadonlySet<string> = new Set([
  "ended",
  "ending",
  "finished",
  "destroyed",
  "errorEmitted",
  "needDrain",
  "objectMode",
  "constructed",
  "closed",
  "prefinished",
]);
const WS_NUM_PROPS: ReadonlySet<string> = new Set([
  "length",
  "highWaterMark",
  "corked",
  "bufferedRequestCount",
]);

export function lowerStreamStateProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const inner = expr.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.questionDotToken) return null;
  const stateName = inner.name.text;
  if (stateName !== "_readableState" && stateName !== "_writableState") return null;
  let recvT: IrType | null;
  try {
    recvT = lowerer.mapTypeOf(lowerer.typeOf(inner.expression));
  } catch {
    return null;
  }
  if (recvT?.kind !== "object") return null;
  const info = lowerer.classes.get(recvT.className);
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  const loc = locOf(expr);
  const readable = stateName === "_readableState";
  if (readable ? sides === "w" : sides === "r") {
    lowerer.noLowering(`${stateName} on a ${recvT.className.slice(1)} (that half is absent)`, expr);
  }
  const name = expr.name.text;
  const prefix = readable ? "rs:" : "ws:";
  const receiver = () => lowerer.lowerExpr(inner.expression);
  if (name === "flowing" && readable) {
    const type: IrType = unionOf(lowerer, [BOOL, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "readable.flowing", args: [receiver()], type, loc };
    return lowerer.maybeNarrow(read, expr);
  }
  if (name === "errored") {
    const type: IrType = unionOf(lowerer, [
      { kind: "object", className: "%Error" },
      { kind: "nullT" },
    ]);
    const read: IrExpr = { kind: "libCall", fn: "stream.errored", args: [receiver()], type, loc };
    return lowerer.maybeNarrow(read, expr);
  }
  const bools = readable ? RS_BOOL_PROPS : WS_BOOL_PROPS;
  const nums = readable ? RS_NUM_PROPS : WS_NUM_PROPS;
  if (bools.has(name) || nums.has(name)) {
    return {
      kind: "libCall",
      fn: "stream.prop",
      args: [receiver(), strLit(prefix + name, loc)],
      type: bools.has(name) ? BOOL : F64,
      loc,
    };
  }
  lowerer.noLowering(
    `reading ${stateName}.${name}`,
    expr,
    "the lowered internal-state view covers the scalar fields (length, ended, flowing, errorEmitted, ...) — object-valued members like pipes and buffered entries have no lowering",
  );
}

/* ── the property surface ─────────────────────────────────────────────── */

const READABLE_BOOL_PROPS: ReadonlySet<string> = new Set(["readable", "readableEnded"]);
const WRITABLE_BOOL_PROPS: ReadonlySet<string> = new Set([
  "writable",
  "writableEnded",
  "writableFinished",
  "writableNeedDrain",
]);
const SHARED_BOOL_PROPS: ReadonlySet<string> = new Set(["destroyed", "closed"]);
const READABLE_NUM_PROPS: ReadonlySet<string> = new Set([
  "readableLength",
  "readableHighWaterMark",
]);
const WRITABLE_NUM_PROPS: ReadonlySet<string> = new Set([
  "writableLength",
  "writableHighWaterMark",
  "writableCorked",
]);

/** Property reads on stream-rooted receivers (`r.readableEnded`,
 * `w.destroyed`, ...). Null for names this spoke does not own. */
export function lowerStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  const name = expr.name.text;
  const loc = locOf(expr);
  const readableSide = sides === "r" || sides === "rw";
  const writableSide = sides === "w" || sides === "rw";

  const propCall = (type: IrType): IrExpr => ({
    kind: "libCall",
    fn: "stream.prop",
    args: [streamReceiverExpr(lowerer, expr.expression), strLit(name, loc)],
    type,
    loc,
  });

  if (
    (readableSide && READABLE_BOOL_PROPS.has(name)) ||
    (writableSide && WRITABLE_BOOL_PROPS.has(name)) ||
    SHARED_BOOL_PROPS.has(name)
  ) {
    return propCall(BOOL);
  }
  if (
    (readableSide && READABLE_NUM_PROPS.has(name)) ||
    (writableSide && WRITABLE_NUM_PROPS.has(name))
  ) {
    return propCall(F64);
  }
  if (name === "readableFlowing" && readableSide) {
    const type: IrType = unionOf(lowerer, [BOOL, { kind: "nullT" }]);
    const read: IrExpr = {
      kind: "libCall",
      fn: "readable.flowing",
      args: [streamReceiverExpr(lowerer, expr.expression)],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, expr);
  }
  if (name === "errored") {
    const type: IrType = unionOf(lowerer, [
      { kind: "object", className: "%Error" },
      { kind: "nullT" },
    ]);
    const read: IrExpr = {
      kind: "libCall",
      fn: "stream.errored",
      args: [streamReceiverExpr(lowerer, expr.expression)],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, expr);
  }
  if (name === "readableObjectMode" && readableSide) {
    // Runtime state: Readable.from streams answer true (object entries).
    return propCall(BOOL);
  }
  if (name === "writableObjectMode" && writableSide) {
    return propCall(BOOL);
  }
  if (name === "allowHalfOpen" && sides === "rw") {
    return propCall(BOOL);
  }
  return null;
}

/** Whether an inline completion callback declares a parameter. Node calls
 * write and end callbacks with an error argument (null on success), but the
 * native callback receives none, so the parameter would read undefined
 * where Node passes null or the error. A function literal with parameters
 * would otherwise adapt to the zero-parameter slot silently. */
function callbackDeclaresParameters(node: ts.Expression): boolean {
  let callback = node;
  while (ts.isParenthesizedExpression(callback)) callback = callback.expression;
  return (
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    callback.parameters.nodes.length > 0
  );
}
