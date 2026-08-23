import { InternalCompilerError } from "../../errors.js";
/* The node:stream lowering (the spoke-module pattern, like
 * lower-emitter.ts): construction of the five runtime stream classes
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
import { dynFallbackType, nodeThrowExpr } from "./lowerer.js";
import type { ClassInfo } from "./lower-classes.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, own } from "./lowerer.js";
import { appendImplicitUndefinedReturn } from "./lower-calls.js";
import { bufEncoding, knownBufEncoding } from "./lower-containers.js";
import { probeLower } from "./lower-exprs.js";
import { BOOL, DYN, F64, IrExpr, IrFunction, IrLibFn, IrStmt, IrType, RUNTIME_STREAM_CLASSES, STRING, SrcLoc, VOID, arrayOf, bytesOf, canBoxFuncIntoDyn, funcOf, typeEquals, typeKey } from "../../ir/nodes.js";
import { boolLit, numLit, strLit } from "../../ir/build.js";

const BYTES = bytesOf("u8");

/** The stream sides of a receiver class: the nearest stream-class
 * ancestor's, or null off the stream hierarchy. */
export function streamSidesOf(L: Lowerer, info: ClassInfo | undefined | null): "r" | "w" | "rw" | null {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.builtinStream) return c.builtinStream;
  }
  return null;
}

/** The instance members the stream spoke owns on stream-rooted
 * receivers (the emitter members ride the base chain as usual). */
export const STREAM_API_MEMBERS: ReadonlySet<string> = new Set([
  "push", "unshift", "read", "pause", "resume", "isPaused", "setEncoding",
  "pipe", "unpipe", "destroy", "write", "end", "cork", "uncork",
  "setDefaultEncoding",
]);

/** The property names the stream spoke owns (lowerStreamProperty) — a
 * subclass field or accessor with one of these names would split-brain
 * against the runtime state, so collection fences them (the
 * EMITTER_API_MEMBERS precedent). */
export const STREAM_PROP_MEMBERS: ReadonlySet<string> = new Set([
  "readable", "readableEnded", "readableFlowing", "readableLength",
  "readableHighWaterMark", "readableObjectMode",
  "writable", "writableEnded", "writableFinished", "writableNeedDrain",
  "writableLength", "writableHighWaterMark", "writableCorked",
  "writableObjectMode", "destroyed", "closed", "errored", "allowHalfOpen",
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

/** The accepted option-callback names (canonical flag order) and the
 * duplex-shaped-head answer for one runtime stream class. */
export function streamCtorShape(cls: string): { fn: string; accepted: readonly string[]; duplexShape: boolean } {
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

/** The per-base FORCED event tuples (runtime-emitted payloads): consulted
 * by the emitter spoke BEFORE the program-global table, so a stream's
 * 'data' never collides with a user event named 'data' on a plain
 * emitter. 'error' stays globally forced to the one-%Error tuple. */
export function streamForcedTuple(L: Lowerer, info: ClassInfo | undefined | null, name: string): IrType[] | null {
  const sides = streamSidesOf(L, info);
  if (!sides) return null;
  const readable: Record<string, IrType[]> = {
    data: [BYTES],
    end: [],
    close: [],
    readable: [],
    pause: [],
    resume: [],
  };
  const writable: Record<string, IrType[]> = {
    drain: [],
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
  L: Lowerer,
  which: string,
  node: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  thisType: IrType,
  fullTuple: IrType[],
): IrExpr {
  const loc = locOf(node);
  const { shapes, funcType } = L.lambdaSignature(node);
  if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    L.unsupported("SC1090", node, `async stream '${which}' callbacks`);
  }
  if (funcType.params.length > fullTuple.length) {
    L.noLowering(
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
    if (!typeEquals(funcType.params[i]!, fullTuple[i]!)) {
      L.noLowering(
        `a '${which}' callback whose parameter ${i} is '${L.fmt(funcType.params[i]!)}' where Node passes '${L.fmt(fullTuple[i]!)}'`,
        node,
        "annotate the parameter with the Node signature's type (chunks are Buffers here)",
      );
    }
  }
  const fnName = `%fn${L.lambdaCounter++}_${which}cb`;
  const fnCtx = newFnCtx(true, null, funcType, funcType.ret);
  L.fnStack.push(fnCtx);
  try {
    // Method shorthand and function expressions see the stream as `this`
    // (Node binds it); arrows keep lexical `this`, so their slot is a
    // hidden ABI local no body reference can resolve to.
    const thisLocal = ts.isArrowFunction(node)
      ? L.declareHiddenLocal("this", thisType)
      : L.declareThis(thisType);
    const { params, prologue } = L.declareParams(node.parameters, shapes);
    let body: IrStmt[];
    if (node.body !== undefined && ts.isBlock(node.body)) {
      body = L.lowerStmts(node.body.statements);
    } else if (node.body !== undefined) {
      // Bare-expression bodies (`read: () => this.push(null)`): the value
      // is discarded when the signature returns void — Node ignores
      // option-callback results either way.
      const bodyExpr = node.body as ts.Expression;
      if (funcType.ret.kind === "void") {
        body = [{ kind: "exprStmt", expr: L.lowerExpr(bodyExpr), loc: locOf(node.body) }];
      } else {
        const value = L.lowerExpr(bodyExpr);
        body = [{ kind: "return", value: L.coerceInto(bodyExpr, value, funcType.ret), loc: locOf(node.body) }];
      }
    } else {
      body = [];
    }
    body = [...prologue, ...body];
    appendImplicitUndefinedReturn(L, body, funcType.ret, loc);
    const ctx = L.ctx;
    const lifted: IrFunction = {
      name: fnName,
      params: [{ localId: thisLocal.id, name: "this", type: thisType }, ...params],
      returnType: funcType.ret,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    };
    L.liftedFns.push(lifted);
    return {
      kind: "closure",
      fnName,
      captures: ctx.captureSources,
      type: funcOf([thisType, ...funcType.params], funcType.ret),
      loc,
    };
  } finally {
    L.fnStack.pop();
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
  /** Present callbacks in canonical order with their flag bits. */
  flags: number;
  cbs: IrExpr[];
}

/** The full Node parameter tuples of the option callbacks, given the
 * concrete stream's `this` type. The trailing completion callbacks keep
 * whatever func type the checker contextually gave the user's parameter
 * (the emitted adapter constructs a matching closure), so only their
 * FUNC-ness is checked here. */
function cbTuples(L: Lowerer): Record<string, (IrType | "fn")[]> {
  return {
    read: [F64],
    write: [BYTES, STRING, "fn"],
    final: ["fn"],
    destroy: [errorOrNull(L), "fn"],
    transform: [BYTES, STRING, "fn"],
    flush: ["fn"],
  };
}

/** Interns a union from unsorted arms (the interner's identity is the
 * typeKey-SORTED arm list — mapType's canonicalization). */
function unionOf(L: Lowerer, arms: IrType[]): IrType {
  const sorted = [...arms].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: L.unions.intern(sorted) };
}

function errorOrNull(L: Lowerer): IrType {
  return unionOf(L, [{ kind: "object", className: "%Error" }, { kind: "nullT" }]);
}

/** The program's property-mutated symbols (`opts.read = f`, `opts["x"]
 * op= v`, `delete opts.y`): a const-initialized options record whose
 * symbol appears here cannot be followed to its literal — the runtime
 * record and the compile-time walk would split-brain. Built once, lazily
 * (the emitterEvents pre-pass precedent); the scan is diagnostic-free. */
function propMutatedSymbols(L: Lowerer): Set<ts.Symbol> {
  const holder = L as unknown as { streamPropMutatedSyms?: Set<ts.Symbol> };
  if (holder.streamPropMutatedSyms) return holder.streamPropMutatedSyms;
  const set = new Set<ts.Symbol>();
  const noteBase = (target: ts.Expression): void => {
    let base = target;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
      base = base.expression;
    }
    if (!ts.isIdentifier(base)) return;
    try {
      const sym = L.resolveValueSymbol(base);
      if (sym) set.add(sym);
    } catch {
      /* not a candidate */
    }
  };
  for (const sf of L.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      ts.forEachChild(node, walk);
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
        noteBase(node.left);
      } else if (ts.isDeleteExpression(node)) {
        noteBase(node.expression);
      }
    };
    walk(sf);
  }
  holder.streamPropMutatedSyms = set;
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
function followOptionsArg(L: Lowerer, arg: ts.Expression | undefined): ts.Expression | null | undefined {
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
      sym = L.resolveValueSymbol(node);
    } catch {
      return node;
    }
    const decl = sym ? L.checker.valueDeclarationOf(sym) : undefined;
    if (!sym || !decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return node;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return node;
    if (propMutatedSymbols(L).has(sym)) return node;
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
  L: Lowerer,
  ctorName: string,
  which: string,
  node: ts.Expression,
  fullLen: number,
): IrExpr {
  const loc = locOf(node);
  const getRecord = (id: string) => L.shapes.get(id);
  const getUnion = (id: string) => L.unions.get(id);
  let t: IrType | null;
  try {
    const ct = L.typeOf(node);
    t = L.mapTypeOf(ct) ?? dynFallbackType(L, node, ct);
  } catch {
    t = null;
  }
  let cbDyn: IrExpr;
  if (t?.kind === "dyn") {
    const v = L.lowerExpr(node);
    cbDyn = v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc };
  } else if (t?.kind === "func") {
    const cb = L.lowerExpr(node);
    if (cb.type.kind !== "func" || !canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      L.noLowering(
        `the ${ctorName} option '${which}' with a function value of this signature`,
        node,
        "a callback value's own parameters and return must cross the checked-dynamic boundary — write the callback inline to keep it fully static",
      );
    }
    cbDyn = { kind: "dynFrom", value: cb, type: DYN, loc };
  } else {
    L.noLowering(
      `the ${ctorName} option '${which}' with a non-function value`,
      node,
      "the callback slot takes an inline function (fully static) or a function value that crosses the checked-dynamic boundary",
    );
  }
  const adapterT = funcOf(Array.from({ length: fullLen }, () => DYN), VOID);
  return { kind: "dynCheck", value: cbDyn, type: adapterT, loc };
}

/** A checked-dynamic options VALUE (the JS lane's `super(options)`
 * forwarding a constructor parameter, `new Readable(dynVar)`): the
 * record's shape is runtime data, so the option walk runs in the runtime
 * (the `.newDyn`/`.initDyn` twins) with Node's own reading rules. Null
 * when the argument is not dyn-flavored (the static walk owns it). */
function dynOptionsValue(L: Lowerer, arg: ts.Expression): IrExpr | null {
  const followed = followOptionsArg(L, arg);
  if (followed === null || followed === undefined || ts.isObjectLiteralExpression(followed)) return null;
  let t: IrType | null;
  try {
    const ct = L.typeOf(followed);
    t = L.mapTypeOf(ct) ?? dynFallbackType(L, followed, ct);
  } catch {
    return null;
  }
  if (t?.kind !== "dyn") return null;
  const v = L.lowerExpr(followed);
  return v.type.kind === "dyn" ? v : null;
}

/** Parses the options object literal of a stream constructor. `which`
 * names the callbacks this class accepts, in canonical flag order. */
function parseStreamOptions(
  L: Lowerer,
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
    flags: 0,
    cbs: [],
  };
  const followed = followOptionsArg(L, arg);
  const optsLit = followed === null ? undefined : followed;
  if (optsLit !== undefined && !ts.isObjectLiteralExpression(optsLit)) {
    L.noLowering(
      `new ${ctorName} with a non-literal options argument`,
      optsLit,
      "the options must be an object literal, inline or through const-initialized bindings (the callbacks lower as compile-time closures)",
    );
  }
  const tuples = cbTuples(L);
  const present = new Map<string, IrExpr>();
  for (const prop of optsLit?.properties ?? []) {
    const propName = ts.isSpreadAssignment(prop) ? undefined : prop.name;
    const name =
      propName && ts.isIdentifier(propName)
        ? propName.text
        : propName && ts.isStringLiteral(propName)
          ? propName.text
          : null;
    if (name === null) {
      L.unsupported("SC1090", prop, `computed or spread members in ${ctorName} options`);
    }
    // Callback members: shorthand methods and function-valued properties.
    if (accepted.includes(name)) {
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
          L.noLowering(
            `the ${ctorName} option '${name}' as this member form`,
            prop,
            "write the callback inline (method shorthand or an inline function/arrow), or pass a function value",
          );
        }
        present.set(name, lowerStreamCallbackValue(L, ctorName, name, valueNode, tuples[name]!.length));
        continue;
      }
      const full = tuples[name]!.map((t) => (t === "fn" ? null : t));
      // The completion-callback tail: typed by the checker contextually;
      // accept the user's declared func type as the tuple's entry so the
      // prefix check compares like with like.
      const { funcType } = L.lambdaSignature(fnNode);
      const tuple: IrType[] = full.map((t, i) => {
        if (t !== null) return t;
        const declared = funcType.params[i];
        if (declared !== undefined && declared.kind !== "func" && declared.kind !== "dyn") {
          L.noLowering(
            `a '${name}' callback whose parameter ${i} is '${L.fmt(declared)}' where Node passes the completion callback`,
            fnNode!,
          );
        }
        return declared ?? funcOf([], VOID);
      });
      present.set(name, lowerStreamCallback(L, name, fnNode, thisType, tuple));
      continue;
    }
    // Scalar options.
    if (!ts.isPropertyAssignment(prop)) {
      L.unsupported("SC1090", prop, `the ${ctorName} option '${name}' as a shorthand/method member`);
    }
    const value = prop.initializer;
    switch (name) {
      case "highWaterMark": {
        const v = L.lowerExprExpecting(value, F64);
        out.hwmR = v;
        out.hwmW = v;
        break;
      }
      case "readableHighWaterMark":
        out.hwmR = L.lowerExprExpecting(value, F64);
        break;
      case "writableHighWaterMark":
        out.hwmW = L.lowerExprExpecting(value, F64);
        break;
      case "autoDestroy":
        out.autoDestroy = L.lowerExprExpecting(value, BOOL);
        break;
      case "emitClose":
        out.emitClose = L.lowerExprExpecting(value, BOOL);
        break;
      case "allowHalfOpen":
        out.allowHalfOpen = L.lowerExprExpecting(value, BOOL);
        break;
      case "objectMode":
      case "readableObjectMode":
      case "writableObjectMode": {
        // `objectMode: false` is the byte default — admit the literal.
        if (value.kind === ts.SyntaxKind.FalseKeyword) break;
        L.noLowering(
          `${ctorName} in objectMode`,
          prop,
          "object-mode streams have no static chunk type yet — chunks are Buffers (utf8 strings convert at push/write)",
        );
        break;
      }
      case "decodeStrings": {
        if (value.kind === ts.SyntaxKind.TrueKeyword) break; // Node's default
        L.noLowering(`${ctorName} with decodeStrings: false`, prop, "chunks always decode to Buffers here (Node's default)");
        break;
      }
      case "encoding": {
        // The readable-side string-chunk mode: a literal encoding, folded
        // to its canonical name (Writable has no such option). A literal
        // spelling Node does not know is Node's RUNTIME rejection —
        // ERR_UNKNOWN_ENCODING at construction, not a compile fence.
        if (ctorName === "Writable") L.noLowering(`the Writable option 'encoding'`, prop);
        {
          const t = L.typeOf(value);
          if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
            out.badEncoding = t.value;
            break;
          }
        }
        out.encoding = bufEncoding(L, `the ${ctorName} option 'encoding'`, value);
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
          const t = L.typeOf(value);
          if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) break;
          if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
            out.badEncoding = t.value;
            break;
          }
          if (t.isStringLiteralType() && ctorName === "Readable") {
            out.pushEncoding = knownBufEncoding(t.value)!;
            break;
          }
        }
        L.noLowering(
          `the ${ctorName} option 'defaultEncoding'`,
          prop,
          "utf8 (the default) is the supported write-side string encoding",
        );
        break;
      case "signal":
        L.noLowering(`the ${ctorName} option 'signal'`, prop, "AbortSignal-driven destruction is not lowered yet");
        break;
      case "captureRejections": {
        // `false` is the default — admit the literal; the rejection-
        // capturing mode has no lowering (async listeners' promises are
        // abandoned unobserved).
        if (value.kind === ts.SyntaxKind.FalseKeyword) break;
        L.noLowering(`the ${ctorName} option 'captureRejections'`, prop, "captureRejections has no lowering (listener rejections are not routed to 'error')");
        break;
      }
      case "readable":
      case "writable": {
        // Duplex side toggles: compile-time literals only (they decide
        // which halves EXIST).
        if (ctorName !== "Duplex") {
          L.noLowering(`the ${ctorName} option '${name}'`, prop);
        }
        if (value.kind === ts.SyntaxKind.TrueKeyword) break;
        if (value.kind === ts.SyntaxKind.FalseKeyword) {
          if (name === "readable") out.readableSide = false;
          else out.writableSide = false;
          break;
        }
        L.noLowering(`the Duplex option '${name}' with a non-literal value`, prop, "the side toggles must be compile-time booleans");
        break;
      }
      case "final": {
        L.noLowering(
          `the ${ctorName} option 'final'`,
          prop,
          ctorName === "Transform"
            ? "a user final on a Transform replaces the _flush composition — no lowering yet"
            : "the final callback is supported on Writable and Duplex",
        );
        break;
      }
      case "construct":
        L.noLowering(`the ${ctorName} option 'construct'`, prop, "deferred construction (_construct) is not lowered yet");
        break;
      case "writev":
        L.noLowering(`the ${ctorName} option 'writev'`, prop, "batched writes (_writev) are not lowered yet — writes deliver one chunk at a time");
        break;
      default:
        L.noLowering(`the ${ctorName} option '${name}'`, prop);
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
  return out;
}

/** The head + flags argument list of a stream construction/initialization
 * (shared by `new Readable({...})` and a subclass's super(options)),
 * plus the parsed `encoding` option (applied as a follow-up setEncoding). */
function streamCtorArgs(L: Lowerer, cls: string, arg: ts.Expression | undefined,
  thisType: IrType, loc: SrcLoc, fallbackCb?: (name: string) => IrExpr | null): { args: IrExpr[]; encoding: string | null; badEncoding: string | null; pushEncoding: string | null } {
  const shape = streamCtorShape(cls);
  const o = parseStreamOptions(L, cls.slice(1), arg, thisType, shape.accepted, loc, fallbackCb);
  const head = shape.duplexShape
    ? [o.hwmR, o.hwmW, o.autoDestroy, o.emitClose, o.allowHalfOpen,
       boolLit(o.readableSide, loc), boolLit(o.writableSide, loc), numLit(o.flags, loc)]
    : [cls === "%Writable" ? o.hwmW : o.hwmR, o.autoDestroy, o.emitClose, numLit(o.flags, loc)];
  return { args: [...head, ...o.cbs], encoding: o.encoding, badEncoding: o.badEncoding, pushEncoding: o.pushEncoding };
}

/** `new Readable(opts?)` and friends — called from lowerNew once the
 * callee resolved to a builtin stream class. */
export function lowerStreamNew(L: Lowerer, expr: ts.NewExpression, info: ClassInfo): IrExpr {
  const loc = locOf(expr);
  const cls = info.def.name;
  if (!RUNTIME_STREAM_CLASSES.has(cls)) L.unsupported("SC1090", expr, `constructing ${cls}`);
  const thisType: IrType = { kind: "object", className: cls };
  const args = expr.arguments ?? [];
  if (args.length > 1) {
    L.noLowering(`new ${info.def.name.slice(1)} with ${args.length} arguments`, expr, "the supported form takes one options object");
  }
  if (args[0] !== undefined) {
    const dynOpts = dynOptionsValue(L, args[0]);
    if (dynOpts !== null) {
      return { kind: "libCall", fn: `${streamCtorShape(cls).fn}.newDyn` as IrLibFn, args: [dynOpts], type: thisType, loc };
    }
  }
  const fn = `${streamCtorShape(cls).fn}.new` as IrLibFn;
  const parsed = streamCtorArgs(L, cls, args[0], thisType, loc);
  if (parsed.badEncoding !== null) {
    // Node's state constructors validate encodings first: an unknown
    // spelling never constructs — the whole expression throws.
    return nodeThrowExpr(1, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${parsed.badEncoding}`, thisType, loc);
  }
  let built: IrExpr = { kind: "libCall", fn, args: parsed.args, type: thisType, loc };
  if (parsed.pushEncoding !== null) {
    // { defaultEncoding }: chain the push-side decode default (the
    // setEncoding chaining shape — answers the receiver +1).
    built = { kind: "libCall", fn: "readable.pushEncoding", args: [built, strLit(parsed.pushEncoding, loc)], type: thisType, loc };
  }
  if (parsed.encoding === null) return built;
  // { encoding }: chain a setEncoding over the fresh stream (the operand
  // temp releases with the frame; setEncoding answers the receiver +1).
  return { kind: "libCall", fn: "readable.setEncoding", args: [built, strLit(parsed.encoding, loc)], type: thisType, loc };
}

/* ── user subclasses (`extends Readable`, the underscore-override form) ── */

/** The wrapper closure binding one overridden underscore method as the
 * runtime's option callback: a lifted (this, ...prefix) function whose
 * body calls the method — through the vtable when some strict subclass
 * overrides it (the ordinary devirtualization rule), so an inherited
 * constructor still binds the DYNAMIC class's override. The method may
 * declare any PREFIX of its Node signature (the option-callback rule). */
function streamMethodWrapper(L: Lowerer, info: ClassInfo, which: string,
  methodName: string, thisType: IrType, loc: SrcLoc, blame: ts.Node): IrExpr | null {
  const found = L.findMethodOn(info, methodName);
  if (!found) {
    // A DESCENDANT-only declaration (the base chain never declares it):
    // this constructor cannot see it, and silently binding nothing would
    // diverge from Node (which dispatches through the prototype chain).
    if (L.overrideBelow(info, methodName)) {
      L.noLowering(
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
  if (found.sig.abstract === true && !L.overrideBelow(info, methodName)) {
    L.noLowering(
      `an abstract '${methodName}' declaration with no concrete implementation below ${info.def.name.replace(/^%/, "")}`,
      blame,
      `implement '${methodName}' on a subclass the program constructs`,
    );
    return null;
  }
  const tuples = cbTuples(L);
  const full = tuples[which]!;
  const declared = found.sig.params;
  if (declared.length > full.length) {
    L.noLowering(
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
      L.noLowering(
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
        L.noLowering(
          `a '${methodName}' method whose parameter ${i} is '${L.fmt(got.type)}' where Node passes the completion callback`,
          blame,
        );
      }
    } else if (!typeEquals(got.type, want)) {
      L.noLowering(
        `a '${methodName}' method whose parameter ${i} is '${L.fmt(got.type)}' where Node passes '${L.fmt(want)}'`,
        blame,
        "annotate the parameter with the Node signature's type (chunks are Buffers here)",
      );
    }
    paramTypes.push(got.type);
  }
  const ret = found.sig.ret;
  const fnName = `%fn${L.lambdaCounter++}_${which}vt`;
  const funcType = funcOf([thisType, ...paramTypes], ret);
  L.fnStack.push(newFnCtx(true, null, funcType, ret));
  try {
    const thisLocal = L.declareThis(thisType);
    const params = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const argRefs: IrExpr[] = [];
    for (let i = 0; i < paramTypes.length; i++) {
      const local = L.declareHiddenLocal(`a${i}`, paramTypes[i]!);
      params.push({ localId: local.id, name: local.name, type: paramTypes[i]! });
      argRefs.push({ kind: "varRef", localId: local.id, type: paramTypes[i]!, loc });
    }
    const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisType, loc };
    let call: IrExpr;
    if (L.overrideBelow(info, methodName)) {
      L.noteVirtualEdge(info, methodName);
      call = { kind: "virtualCall", className: info.def.name, method: methodName, args: [thisRef, ...argRefs], type: ret, loc };
    } else {
      L.noteEdge(`%${found.declarer.def.name}.${methodName}`);
      call = {
        kind: "call",
        callee: `%${found.declarer.def.name}.${methodName}`,
        args: [L.upcastTo(thisRef, found.declarer.def.name), ...argRefs],
        type: ret,
        loc,
      };
    }
    const body: IrStmt[] =
      ret.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc }]
        : [{ kind: "return", value: call, loc }];
    appendImplicitUndefinedReturn(L, body, ret, loc);
    const ctx = L.ctx;
    L.liftedFns.push({
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
    L.fnStack.pop();
  }
}

/** `super(options?)` in a class whose direct base chain lands on a
 * runtime stream class: lowers to the stream.init libCall over `this`
 * (the emitted allocation already stamped the subclass vtable and
 * display name; the runtime builds the state block). Options parse
 * exactly like the construction form; overridden underscore methods on
 * the class chain fill callbacks the options leave unset. */
export function lowerStreamSuperCall(L: Lowerer, info: ClassInfo, base: ClassInfo,
  argNodes: readonly ts.Expression[], thisLocal: { id: string }, loc: SrcLoc, blame: ts.Node): IrStmt[] {
  const cls = base.def.name;
  const thisType: IrType = { kind: "object", className: info.def.name };
  if (argNodes.length > 1) {
    L.noLowering(`super(...) with ${argNodes.length} arguments in a ${cls.slice(1)} subclass`, blame, "the supported form takes one inline options object (or none)");
  }
  const shape = streamCtorShape(cls);
  const fallback = (name: string): IrExpr | null => {
    const methodName = UNDERSCORE_METHODS.get(name);
    return methodName ? streamMethodWrapper(L, info, name, methodName, thisType, loc, blame) : null;
  };
  const thisRef = (): IrExpr => ({ kind: "varRef", localId: thisLocal.id, type: thisType, loc });
  if (argNodes[0] !== undefined) {
    const dynOpts = dynOptionsValue(L, argNodes[0]);
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
      return [{
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: `${shape.fn}.initDyn` as IrLibFn,
          args: [thisRef(), dynOpts, numLit(flags, loc), ...cbs],
          type: VOID,
          loc,
        },
        loc,
      }];
    }
  }
  const parsed = streamCtorArgs(L, cls, argNodes[0], thisType, loc, fallback);
  if (parsed.badEncoding !== null) {
    // super(options) with an unknown literal encoding: the state ctor
    // rejects before any initialization, Node's ladder.
    return [{
      kind: "exprStmt",
      expr: nodeThrowExpr(1, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${parsed.badEncoding}`, VOID, loc),
      loc,
    }];
  }
  const out: IrStmt[] = [{
    kind: "exprStmt",
    expr: { kind: "libCall", fn: `${shape.fn}.init` as IrLibFn, args: [thisRef(), ...parsed.args], type: VOID, loc },
    loc,
  }];
  if (parsed.pushEncoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "readable.pushEncoding", args: [thisRef(), strLit(parsed.pushEncoding, loc)], type: thisType, loc },
      loc,
    });
  }
  if (parsed.encoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: { kind: "libCall", fn: "readable.setEncoding", args: [thisRef(), strLit(parsed.encoding, loc)], type: thisType, loc },
      loc,
    });
  }
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
export function lowerStreamUnderscoreAssign(L: Lowerer, expr: ts.BinaryExpression): IrStmt | null {
  if (!ts.isPropertyAccessExpression(expr.left) || expr.left.questionDotToken) return null;
  const methodName = expr.left.name.text;
  if (!methodName.startsWith("_")) return null;
  const optionByMethod = new Map(Array.from(UNDERSCORE_METHODS, ([o, m]) => [m, o] as const));
  if (!optionByMethod.has(methodName) && methodName !== "_writev" && methodName !== "_construct") return null;
  const recv = probeLower(L, expr.left.expression);
  if (!recv || recv.type.kind !== "object") return null;
  const info = L.classes.get(recv.type.className);
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
  if (methodName === "_writev" || methodName === "_construct") {
    L.noLowering(
      `assigning '${methodName}' on a ${clsName}`,
      expr.left,
      methodName === "_writev"
        ? "batched writes (_writev) are not lowered yet — writes deliver one chunk at a time"
        : "deferred construction (_construct) is not lowered yet",
    );
  }
  const which = optionByMethod.get(methodName)!;
  const { accepted } = streamCtorShape(cls);
  if (!accepted.includes(which)) {
    L.noLowering(
      `assigning '${methodName}' on a ${clsName}`,
      expr.left,
      `a ${clsName}'s machinery consumes ${accepted.map((a) => `'${UNDERSCORE_METHODS.get(a)}'`).join("/")} — '${methodName}' would ride machinery with no lowering here`,
    );
  }
  const thisType: IrType = recv.type;
  const tuples = cbTuples(L);
  let cb: IrExpr;
  const rhs = expr.right;
  if (ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs)) {
    const full = tuples[which]!.map((t) => (t === "fn" ? null : t));
    const { funcType } = L.lambdaSignature(rhs);
    const tuple: IrType[] = full.map((t, i) => {
      if (t !== null) return t;
      const declared = funcType.params[i];
      if (declared !== undefined && declared.kind !== "func" && declared.kind !== "dyn") {
        L.noLowering(
          `a '${methodName}' callback whose parameter ${i} is '${L.fmt(declared)}' where Node passes the completion callback`,
          rhs,
        );
      }
      return declared ?? funcOf([], VOID);
    });
    cb = lowerStreamCallback(L, which, rhs, thisType, tuple);
  } else {
    cb = lowerStreamCallbackValue(L, clsName, which, rhs, tuples[which]!.length);
  }
  const SET_FNS: Record<string, IrLibFn> = {
    read: "stream.setRead",
    write: "stream.setWrite",
    final: "stream.setFinal",
    destroy: "stream.setDestroy",
    transform: "stream.setTransform",
    flush: "stream.setFlush",
  };
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: SET_FNS[which]!, args: [recv, cb], type: VOID, loc },
    loc,
  };
}

/* ── the static surface (Readable.from) ───────────────────────────────── */

/** `Readable.from(iterable)` — the array-seeded object-entry form:
 * string[] / Buffer[] values (or literals) become a fully-seeded
 * readable delivering one WHOLE chunk per element (Node's objectMode
 * accounting; hwm 1), and a single string/Buffer argument is a
 * one-chunk stream (Node's special case). Called from the method-call
 * chain once the receiver resolved to a stream class value. */
export function lowerStreamStaticCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  let symbol: ts.Symbol | null | undefined = null;
  if (ts.isIdentifier(access.expression)) {
    symbol = L.resolveValueSymbol(access.expression);
  } else if (ts.isPropertyAccessExpression(access.expression) && ts.isIdentifier(access.expression.name)) {
    const memberSym = L.checker.getSymbolAtLocation(access.expression.name);
    symbol = memberSym && memberSym.flags & ts.SymbolFlags.Alias
      ? L.checker.getAliasedSymbol(memberSym)
      : memberSym;
  }
  if (!symbol) return null;
  const info = L.builtinStreamInfoOf(symbol);
  if (!info) return null;
  const member = access.name.text;
  const loc = locOf(call);
  const cls = info.def.name;
  // Readable.toWeb's type-option ladder (JS sources): a provably-invalid
  // `type` throws Node's ERR_INVALID_ARG_VALUE before any web stream
  // exists; valid shapes keep the fence — the web bridge has no lowering.
  if (member === "toWeb" && cls === "%Readable" && call.arguments.length === 2 &&
      isJsSourceFile(call.getSourceFile()) && ts.isObjectLiteralExpression(call.arguments[1]!)) {
    for (const p of call.arguments[1]!.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "type") {
        const t = L.typeOf(p.initializer);
        if (t.isStringLiteralType() && t.value !== "bytes") {
          L.lowerExpr(call.arguments[0]!); // evaluation order (the stream argument)
          return nodeThrowExpr(
            1,
            "ERR_INVALID_ARG_VALUE",
            `The property 'options.type' must be one of: 'bytes', undefined. Received '${t.value}'`,
            L.mapTypeOf(L.typeOf(call)) ?? DYN,
            loc,
          );
        }
      }
    }
  }
  if (member !== "from") {
    L.noLowering(`${cls.slice(1)}.${member}`, call);
  }
  if (cls !== "%Readable") {
    L.noLowering(`${cls.slice(1)}.from`, call, "Readable.from is the lowered form");
  }
  const args = call.arguments;
  if (args.length !== 1) {
    L.noLowering(`Readable.from with ${args.length} arguments`, call, "the one-argument form (an array, string, or Buffer) is supported");
  }
  const srcT = L.mapTypeOf(L.typeOf(args[0]!));
  const type: IrType = { kind: "object", className: "%Readable" };
  if (srcT?.kind === "array" && (srcT.elem.kind === "string" || (srcT.elem.kind === "bytes" && srcT.elem.elem === "u8"))) {
    const arr = L.lowerExpr(args[0]!);
    const strings = srcT.elem.kind === "string";
    return { kind: "libCall", fn: "readable.fromArr", args: [arr, boolLit(strings, loc)], type, loc };
  }
  if (srcT?.kind === "string" || (srcT?.kind === "bytes" && srcT.elem === "u8")) {
    // Node special-cases a single string/Buffer: ONE whole chunk.
    const v = L.lowerExpr(args[0]!);
    const strings = srcT.kind === "string";
    const arr: IrExpr = { kind: "arrayLit", elems: [v], type: arrayOf(v.type), loc };
    return { kind: "libCall", fn: "readable.fromArr", args: [arr, boolLit(strings, loc)], type, loc };
  }
  L.noLowering(
    `Readable.from over a '${srcT ? L.fmt(srcT) : "?"}' source`,
    args[0]!,
    "string[] / Buffer[] arrays (and a single string or Buffer) are the supported sources — generators and async iterables have no lowering yet",
  );
}

/** `const Writable = stream.Writable` — a runtime stream CLASS bound
 * through a namespace member: alias plumbing with no storage (both
 * declaration walks skip it; uses resolve through builtinStreamInfoOf's
 * alias following). Only the five stream class names count — value
 * members (stream.getDefaultHighWaterMark as a value, ...) keep their
 * per-site fences. */
export function streamClassAliasDecl(L: Lowerer, nameNode: ts.Node, init: ts.Expression | undefined): boolean {
  if (!ts.isIdentifier(nameNode) || !init) return false;
  if (!ts.isPropertyAccessExpression(init) || init.questionDotToken) return false;
  let isStreamClass = false;
  for (const [, rec] of RUNTIME_STREAM_CLASSES) {
    if (rec.lib === init.name.text) isStreamClass = true;
  }
  if (!isStreamClass) return false;
  return L.builtinNamespaceModuleOf(init.expression) === "stream";
}

/* ── the module functions (finished / pipeline — the callback forms) ──── */

/** Node's pipeline stage ladder text (lib/internal/streams/pipeline.js's
 * makeAsyncIterable — every stage position renders the same "body"
 * clause). finished() keeps its narrower isNodeStream wording. */
const PIPELINE_STAGE_EXPECTED =
  "of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair";

/** A stream-rooted argument, lowered — or the pointed fence (pipeline's
 * iterable/generator/function stages have no lowering yet). `what` picks
 * the validation ladder: finished() rejects EVERY non-stream through
 * isNodeStream, while pipeline() accepts iterables (strings, arrays) and
 * { readable, writable } pairs — those shapes fence instead of throwing
 * a ladder Node never throws. */
function lowerStreamArg(L: Lowerer, node: ts.Expression, what: "finished" | "pipeline"): IrExpr {
  const v = L.lowerExpr(node);
  const info = v.type.kind === "object" ? L.classes.get(v.type.className) : undefined;
  if (!streamSidesOf(L, info)) {
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
    if (isJsSourceFile(node.getSourceFile()) && L.dynConvertible(v.type)) {
      if (what === "pipeline") {
        // Strings and arrays are iterables — VALID pipeline stages in
        // Node — and a record carrying a readable/writable member may be
        // the duplex-pair form; none of those shapes has a lowering, so
        // they take the pointed fence below, never a throw.
        const pairish = v.type.kind === "record" &&
          (L.shapes.get(v.type.shapeId)?.fields ?? []).some((f) => f.name === "readable" || f.name === "writable");
        if ((v.type.kind === "record" && !pairish) || v.type.kind === "f64" ||
            v.type.kind === "bool" || v.type.kind === "nullT") {
          argTypeThrow("body", PIPELINE_STAGE_EXPECTED);
        }
      } else if (v.type.kind === "record" || v.type.kind === "string" || v.type.kind === "f64" ||
                 v.type.kind === "bool" || v.type.kind === "array" || v.type.kind === "nullT") {
        argTypeThrow("stream", "an instance of ReadableStream, WritableStream, or Stream");
      }
    }
    L.noLowering(
      `${what} over a '${L.fmt(v.type)}'`,
      node,
      what === "pipeline"
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
class StreamArgTypeThrow {
  constructor(readonly expr: IrExpr) {}
}

/** The finished/pipeline completion callback: an inline function lowers
 * through the option-callback machinery (leading `this`, an `Error |
 * null` prefix — Node binds the stream and passes the error); any other
 * value adapts through the checked-dynamic boundary (mustCall wrappers —
 * the runtime inv calls it with NO arguments on success, Node's eos
 * convention). */
function lowerEosCallback(
  L: Lowerer,
  which: string,
  node: ts.Expression,
  thisType: IrType,
): { cb: IrExpr; dyn: boolean } {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // The error parameter takes what the user declared when it is an
    // Error/null/undefined union (@types spells `ErrnoException | null |
    // undefined`); the emitted thunk picks the undefined arm on success.
    let tuple: IrType[] = [errorOrNull(L)];
    try {
      const { funcType } = L.lambdaSignature(node);
      const p0 = funcType.params[0];
      if (p0?.kind === "union") {
        const def = L.unions.get(p0.unionId);
        if (def && def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
            def.arms.every((a) => a.kind === "nullT" || a.kind === "undefinedT" ||
              (a.kind === "object" && a.className === "%Error"))) {
          tuple = [p0];
        }
      }
    } catch {
      /* the fixed tuple speaks */
    }
    return { cb: lowerStreamCallback(L, which, node, thisType, tuple), dyn: false };
  }
  const getRecord = (id: string) => L.shapes.get(id);
  const getUnion = (id: string) => L.unions.get(id);
  let t: IrType | null;
  try {
    const ct = L.typeOf(node);
    t = L.mapTypeOf(ct) ?? dynFallbackType(L, node, ct);
  } catch {
    t = null;
  }
  if (t?.kind === "dyn") {
    const v = L.lowerExpr(node);
    if (v.type.kind === "dyn") return { cb: v, dyn: true };
  } else if (t?.kind === "func") {
    const cb = L.lowerExpr(node);
    if (cb.type.kind === "func" && canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      return { cb: { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) }, dyn: true };
    }
  }
  L.noLowering(
    `${which} with this callback value`,
    node,
    "write the callback inline, or pass a function value that crosses the checked-dynamic boundary",
  );
}

/** `finished(...)` / `pipeline(...)` / `getDefaultHighWaterMark(...)`
 * imported from node:stream (named imports, destructured requires, and
 * namespace-member calls all land here). Null for members this spoke
 * does not own — the caller's module-qualified fence speaks. */
export function lowerStreamModuleCall(L: Lowerer, call: ts.CallExpression,
  bi: { module: string; member: string }, loc: SrcLoc): IrExpr | null {
  if (bi.module === "stream/promises") {
    const args = call.arguments;
    // finished(stream) → a pending void promise the terminal watcher
    // settles (rejected with the stream's error, or
    // ERR_STREAM_PREMATURE_CLOSE — the callback form's status, boxed
    // through the promise instead). The options argument has no lowering.
    if (bi.member === "finished") {
      if (args.length !== 1) {
        L.noLowering(
          `stream/promises.finished with ${args.length} arguments`,
          call,
          args.length === 2 ? "the options argument has no lowering yet — the one-argument form is supported" : "the supported form is finished(stream)",
        );
      }
      let recv: IrExpr;
      try {
        recv = lowerStreamArg(L, args[0]!, "finished");
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) return e.expr;
        throw e;
      }
      return { kind: "libCall", fn: "sp.finished", args: [recv], type: { kind: "promise", inner: VOID }, loc };
    }
    // pipeline(...streams) → the callback pipeline's chaining/destroyer
    // semantics with the settlement on a promise. Stream stages only
    // (lowerStreamArg's fence); Node's promise resolves undefined for
    // stream destinations, so the result is a void promise.
    if (bi.member === "pipeline") {
      if (args.length < 2) {
        L.noLowering(`stream/promises.pipeline with ${args.length} arguments`, call, "the supported form is pipeline(source, ...streams)");
      }
      let streams: IrExpr[];
      try {
        streams = args.map((a) => lowerStreamArg(L, a, "pipeline"));
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) return e.expr;
        throw e;
      }
      return {
        kind: "libCall",
        fn: "sp.pipeline",
        args: [numLit(streams.length, loc), ...streams],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    return null;
  }
  if (bi.module === "stream/consumers") {
    const args = call.arguments;
    // text/json/buffer(stream) → a pending promise the accumulate-and-
    // settle machinery resolves at the terminal point (the utf8 decode / the parsed
    // JSON dyn tree / the concatenated bytes) or rejects — with the stream's
    // error, ERR_STREAM_PREMATURE_CLOSE on an early close, or json's
    // SyntaxError on malformed text, Node's own rejection set.
    // arrayBuffer/blob return null here: neither value has a
    // representation, so the module-qualified fence (with the pointed
    // hints in BUILTIN_MODULE_FENCE_HINTS) speaks.
    if (bi.member === "text" || bi.member === "json" || bi.member === "buffer") {
      if (args.length !== 1) {
        L.noLowering(
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
      const argV = L.lowerExpr(args[0]!);
      const argInfo = argV.type.kind === "object" ? L.classes.get(argV.type.className) : undefined;
      if (argV.type.kind !== "dyn" && argV.type.kind !== "jsval" && !streamSidesOf(L, argInfo)) {
        L.noLowering(
          `stream/consumers.${bi.member} over a value that is not a stream`,
          call,
          "Node rejects the promise with 'stream is not async iterable' — pass a readable stream",
        );
      }
      const recv: IrExpr = argV;
      const inner: IrType = bi.member === "text" ? STRING : bi.member === "json" ? DYN : BYTES;
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
  const args = call.arguments;

  if (bi.member === "getDefaultHighWaterMark") {
    // Node 24: 65536 bytes / 16 objects — compile-time literals only.
    // The byte default is platform-split at Node's source
    // (lib/internal/streams/state.js: win32 keeps 16 KiB), so the fold
    // follows the TARGET platform like the path-module binding.
    if (args.length === 1 && args[0]!.kind === ts.SyntaxKind.FalseKeyword) {
      return numLit(L.targetPlatform === "win32" ? 16384 : 65536, loc);
    }
    if (args.length === 1 && args[0]!.kind === ts.SyntaxKind.TrueKeyword) return numLit(16, loc);
    L.noLowering("getDefaultHighWaterMark with a non-literal argument", call, "the objectMode flag must be a compile-time boolean");
  }

  if (bi.member === "finished") {
    if (args.length !== 2) {
      L.noLowering(
        `finished with ${args.length} arguments`,
        call,
        args.length === 3 ? "the options argument has no lowering yet — the two-argument form is supported" : "the supported form is finished(stream, callback)",
      );
    }
    let recv: IrExpr;
    try {
      recv = lowerStreamArg(L, args[0]!, "finished");
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    const { cb, dyn } = lowerEosCallback(L, "finished", args[1]!, recv.type);
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
      L.noLowering(`pipeline with ${args.length} arguments`, call, "the supported form is pipeline(source, ...streams, callback)");
    }
    let streams: IrExpr[];
    try {
      streams = args.slice(0, -1).map((a) => lowerStreamArg(L, a, "pipeline"));
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    const last = streams[streams.length - 1]!;
    const { cb, dyn } = lowerEosCallback(L, "pipeline", args[args.length - 1]!, last.type);
    return {
      kind: "libCall",
      fn: dyn ? "stream.pipelineDyn" : "stream.pipeline",
      args: [numLit(streams.length, loc), ...streams, cb],
      type: last.type,
      loc,
    };
  }

  return null;
}

/* ── the method surface ───────────────────────────────────────────────── */

/** The one supported encoding argument: utf8 (Node's default), as a
 * compile-time literal or absent. */
function checkUtf8Encoding(L: Lowerer, member: string, arg: ts.Expression | undefined): void {
  if (arg === undefined) return;
  const t = L.typeOf(arg);
  if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) return;
  L.noLowering(
    `${member} with a ${t.isStringLiteralType() ? `'${t.value}'` : "non-literal"} encoding`,
    arg,
    "utf8 (as a compile-time literal) is the supported encoding",
  );
}

/** `recv.<member>(...)` over a stream-rooted receiver. Returns null only
 * for members this spoke does not own. */
export function lowerStreamMethodCall(L: Lowerer, call: ts.CallExpression,
  access: ts.PropertyAccessExpression, info: ClassInfo): IrExpr | null {
  const member = access.name.text;
  if (!STREAM_API_MEMBERS.has(member)) return null;
  const sides = streamSidesOf(L, info);
  if (!sides) return null;
  const loc = locOf(call);
  const args = call.arguments;
  const readableSide = sides === "r" || sides === "rw";
  const writableSide = sides === "w" || sides === "rw";
  const cls = info.def.name.slice(1);

  const requireSide = (need: boolean, what: string): void => {
    if (!need) {
      L.noLowering(`${what} on a ${cls} (the ${what.startsWith("write") || what === "end" || what === "cork" || what === "uncork" ? "writable" : "readable"} half is absent)`, call);
    }
  };

  // Chunk classification for push/unshift/write/end. Union-typed chunks
  // over {Buffer, string, null} dispatch by tag at runtime — the
  // `push(more ? next : null)` idiom.
  const chunkKind = (node: ts.Expression): "bytes" | "string" | "null" | "union" | "dyn" => {
    if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
    const t = L.mapTypeOf(L.typeOf(node));
    if (t?.kind === "bytes" && t.elem === "u8") return "bytes";
    if (t?.kind === "string") return "string";
    if (t?.kind === "nullT") return "null";
    if (t?.kind === "dyn") {
      // The JS lane's any-typed chunk: the runtime dispatches by dyn tag
      // (bytes / string / null; anything else is the write TypeError).
      return "dyn";
    }
    if (t?.kind === "union") {
      const def = L.unions.get(t.unionId);
      if (def && def.arms.every((a) =>
        (a.kind === "bytes" && a.elem === "u8") || a.kind === "string" || a.kind === "nullT")) {
        return "union";
      }
    }
    if (t === null) {
      // A checker-untyped chunk (the JS lane's `t.write(x.toString())`
      // shapes): the LOWERING may still land on a supported kind — probe
      // it (the probe's IR is discarded; the caller re-lowers the node).
      const probed = probeLower(L, node);
      if (probed?.type.kind === "string") return "string";
      if (probed?.type.kind === "bytes" && probed.type.elem === "u8") return "bytes";
      if (probed?.type.kind === "dyn") return "dyn";
      if (probed?.type.kind === "nullT") return "null";
    }
    L.noLowering(
      `${member} with a '${t ? L.fmt(t) : "?"}' chunk`,
      node,
      "chunks are Buffers or utf8 strings — or unions of those with null (objectMode is not lowered)",
    );
  };

  if (member === "push" || member === "unshift") {
    requireSide(readableSide, member);
    if (args.length === 0 || args.length > 2) {
      L.noLowering(`${member} with ${args.length} arguments`, call, "the supported forms are (chunk) and (chunk, \"utf8\")");
    }
    // push(chunk, enc) with a LITERAL encoding: the per-call decode
    // (Buffer.from(chunk, enc)) — an explicit encoding (utf8 included)
    // overrides the stream's defaultEncoding; unknown literals throw
    // Node's ERR_UNKNOWN_ENCODING when the push evaluates. unshift keeps
    // the utf8-only fence below.
    if (member === "push" && args[1] !== undefined && chunkKind(args[0]!) === "string") {
      const t = L.typeOf(args[1]!);
      if (t.isStringLiteralType()) {
        const canonical = knownBufEncoding(t.value);
        if (canonical === undefined) {
          return nodeThrowExpr(1, "ERR_UNKNOWN_ENCODING", `Unknown encoding: ${t.value}`, BOOL, loc);
        }
        const receiver = L.lowerExpr(access.expression);
        const chunk = L.lowerExprExpecting(args[0]!, STRING);
        return {
          kind: "libCall",
          fn: "readable.pushStrEnc",
          args: [receiver, chunk, strLit(canonical, loc)],
          type: BOOL,
          loc,
        };
      }
    }
    checkUtf8Encoding(L, member, args[1]);
    const kind = chunkKind(args[0]!);
    if ((kind === "null" || kind === "union" || kind === "dyn") && member === "unshift") {
      L.noLowering(kind === "null" ? "unshift(null)" : "unshift with a nullable or dynamic chunk", call, "EOF signals through push(null)");
    }
    const receiver = L.lowerExpr(access.expression);
    if (kind === "null") {
      return { kind: "libCall", fn: "readable.pushNull", args: [receiver], type: BOOL, loc };
    }
    if (kind === "dyn") {
      const chunk = L.lowerExprExpecting(args[0]!, DYN);
      return { kind: "libCall", fn: "readable.pushDyn", args: [receiver, chunk], type: BOOL, loc };
    }
    if (kind === "union") {
      // The lowered value may have collapsed to one arm (checker
      // narrowing) — re-dispatch on its IR type.
      const chunk = L.lowerExpr(args[0]!);
      if (chunk.type.kind === "union") {
        return { kind: "libCall", fn: "readable.pushU", args: [receiver, chunk], type: BOOL, loc };
      }
      if (chunk.type.kind === "bytes") {
        return { kind: "libCall", fn: "readable.push", args: [receiver, chunk], type: BOOL, loc };
      }
      if (chunk.type.kind === "string") {
        return { kind: "libCall", fn: "readable.pushStr", args: [receiver, chunk], type: BOOL, loc };
      }
      return { kind: "libCall", fn: "readable.pushNull", args: [receiver], type: BOOL, loc };
    }
    const chunk = kind === "bytes" ? L.lowerExprExpecting(args[0]!, BYTES) : L.lowerExprExpecting(args[0]!, STRING);
    const fn = member === "push"
      ? (kind === "bytes" ? "readable.push" : "readable.pushStr")
      : (kind === "bytes" ? "readable.unshift" : "readable.unshiftStr");
    return { kind: "libCall", fn, args: [receiver, chunk], type: member === "push" ? BOOL : VOID, loc };
  }

  if (member === "read") {
    requireSide(readableSide, "read");
    if (args.length > 1) L.noLowering(`read with ${args.length} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    const size = args[0] ? L.lowerExprExpecting(args[0], F64) : numLit(-1, loc);
    const type: IrType = unionOf(L, [BYTES, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "readable.read", args: [receiver, size], type, loc };
    return L.maybeNarrow(read, call);
  }

  if (member === "pause" || member === "resume") {
    requireSide(readableSide, member);
    if (args.length !== 0) L.noLowering(`${member} with arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: member === "pause" ? "readable.pause" : "readable.resume", args: [receiver], type: receiver.type, loc };
  }

  if (member === "isPaused") {
    requireSide(readableSide, "isPaused");
    if (args.length !== 0) L.noLowering(`isPaused with arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "readable.isPaused", args: [receiver], type: BOOL, loc };
  }

  if (member === "pipe") {
    requireSide(readableSide, "pipe");
    if (args.length === 0 || args.length > 2) {
      L.noLowering(`pipe with ${args.length} arguments`, call, "the supported forms are (destination) and (destination, { end })");
    }
    const dst = L.lowerExpr(args[0]!);
    const dstInfo = dst.type.kind === "object" ? L.classes.get(dst.type.className) : undefined;
    const dstSides = streamSidesOf(L, dstInfo);
    if (dstSides !== "w" && dstSides !== "rw") {
      L.noLowering(
        `pipe into a '${L.fmt(dst.type)}'`,
        args[0]!,
        "the destination must be a stream Writable/Duplex (process streams and sockets are not pipe destinations yet)",
      );
    }
    let end: IrExpr = boolLit(true, loc);
    if (args[1] !== undefined) {
      if (!ts.isObjectLiteralExpression(args[1])) {
        L.noLowering("pipe with a non-literal options argument", args[1], "{ end: <bool> } inline is the supported form");
      }
      for (const prop of args[1].properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== "end") {
          L.noLowering("a pipe option other than 'end'", prop);
        }
        end = L.lowerExprExpecting(prop.initializer, BOOL);
      }
    }
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "readable.pipe", args: [receiver, dst, end], type: dst.type, loc };
  }

  if (member === "unpipe") {
    requireSide(readableSide, "unpipe");
    if (args.length > 1) L.noLowering(`unpipe with ${args.length} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    if (args[0] !== undefined) {
      const dst = L.lowerExpr(args[0]);
      const dstInfo = dst.type.kind === "object" ? L.classes.get(dst.type.className) : undefined;
      const dstSides = streamSidesOf(L, dstInfo);
      if (dstSides !== "w" && dstSides !== "rw") {
        L.noLowering(`unpipe of a '${L.fmt(dst.type)}'`, args[0]);
      }
      return { kind: "libCall", fn: "readable.unpipe", args: [receiver, dst], type: receiver.type, loc };
    }
    return { kind: "libCall", fn: "readable.unpipe", args: [receiver], type: receiver.type, loc };
  }

  if (member === "destroy") {
    if (args.length > 1) L.noLowering(`destroy with ${args.length} arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    if (args[0] !== undefined) {
      const err = L.lowerExpr(args[0]);
      const rootsAtError = (t: IrType): boolean => {
        if (t.kind !== "object") return false;
        for (let c: ClassInfo | null = L.classes.get(t.className) ?? null; c; c = c.base) {
          if (c.def.name === "%Error") return true;
        }
        return false;
      };
      if (!rootsAtError(err.type)) {
        L.noLowering(`destroy with a '${L.fmt(err.type)}' argument`, args[0], "the supported argument is an Error-hierarchy instance");
      }
      return { kind: "libCall", fn: "stream.destroyErr", args: [receiver, L.upcastTo(err, "%Error")], type: receiver.type, loc };
    }
    return { kind: "libCall", fn: "stream.destroy", args: [receiver], type: receiver.type, loc };
  }

  if (member === "write") {
    requireSide(writableSide, "write");
    if (args.length === 0 || args.length > 3) {
      L.noLowering(`write with ${args.length} arguments`, call);
    }
    const kind = chunkKind(args[0]!);
    if (kind === "null") L.noLowering("write(null)", call, "end() finishes a writable");
    if (kind === "dyn") {
      if (args.length > 1) L.noLowering("write with a dynamic chunk and more arguments", call);
      const receiver = L.lowerExpr(access.expression);
      const chunk = L.lowerExprExpecting(args[0]!, DYN);
      return { kind: "libCall", fn: "writable.writeDyn", args: [receiver, chunk], type: BOOL, loc };
    }
    if (kind === "union") {
      // Bytes/string arms dispatch at runtime; a null arm value throws
      // Node's ERR_STREAM_NULL_VALUES TypeError in the runtime. The
      // lowered value may have collapsed to one arm (checker narrowing) —
      // re-dispatch on its IR type.
      if (args.length > 1) L.noLowering("write with a union chunk and more arguments", call);
      const receiver = L.lowerExpr(access.expression);
      const chunk = L.lowerExpr(args[0]!);
      const fn = chunk.type.kind === "union" ? "writable.writeU"
        : chunk.type.kind === "string" ? "writable.writeStr" : "writable.write";
      if (chunk.type.kind === "nullT") L.noLowering("write(null)", call, "end() finishes a writable");
      return { kind: "libCall", fn, args: [receiver, chunk], type: BOOL, loc };
    }
    // Disambiguate (chunk, cb?) vs (chunk, encoding, cb?) by the second
    // argument's static type.
    let cbArg: ts.Expression | undefined;
    if (args.length === 2) {
      const t = L.mapTypeOf(L.typeOf(args[1]!));
      if (t?.kind === "string") checkUtf8Encoding(L, "write", args[1]);
      else cbArg = args[1];
    } else if (args.length === 3) {
      checkUtf8Encoding(L, "write", args[1]);
      cbArg = args[2];
    }
    const receiver = L.lowerExpr(access.expression);
    const chunk = kind === "bytes" ? L.lowerExprExpecting(args[0]!, BYTES) : L.lowerExprExpecting(args[0]!, STRING);
    const fn = kind === "bytes" ? "writable.write" : "writable.writeStr";
    if (cbArg !== undefined) {
      const cb = L.lowerExprExpecting(cbArg, funcOf([], VOID));
      if (cb.type.kind !== "func" || cb.type.params.length > 0) {
        L.noLowering(
          "write completion callbacks taking the error argument",
          cbArg,
          "() => void callbacks are supported (listen for 'error' to observe failures)",
        );
      }
      return { kind: "libCall", fn, args: [receiver, chunk, cb], type: BOOL, loc };
    }
    return { kind: "libCall", fn, args: [receiver, chunk], type: BOOL, loc };
  }

  if (member === "end") {
    requireSide(writableSide, "end");
    if (args.length > 3) L.noLowering(`end with ${args.length} arguments`, call);
    // Forms: (), (cb), (chunk), (chunk, cb), (chunk, encoding, cb).
    let chunkNode: ts.Expression | undefined;
    let cbArg: ts.Expression | undefined;
    if (args.length === 1) {
      const t = L.mapTypeOf(L.typeOf(args[0]!));
      if (t?.kind === "func") cbArg = args[0];
      else chunkNode = args[0];
    } else if (args.length === 2) {
      chunkNode = args[0];
      const t = L.mapTypeOf(L.typeOf(args[1]!));
      if (t?.kind === "string") checkUtf8Encoding(L, "end", args[1]);
      else cbArg = args[1];
    } else if (args.length === 3) {
      chunkNode = args[0];
      checkUtf8Encoding(L, "end", args[1]);
      cbArg = args[2];
    }
    const receiver = L.lowerExpr(access.expression);
    let flags = 0;
    const tail: IrExpr[] = [];
    if (chunkNode !== undefined) {
      const kind = chunkKind(chunkNode);
      if (kind === "null" || kind === "union") L.noLowering("end(null)", call);
      flags |= kind === "bytes" ? 1 : kind === "dyn" ? 8 : 2;
      tail.push(
        kind === "bytes" ? L.lowerExprExpecting(chunkNode, BYTES)
        : kind === "dyn" ? L.lowerExprExpecting(chunkNode, DYN)
        : L.lowerExprExpecting(chunkNode, STRING),
      );
    }
    if (cbArg !== undefined) {
      const cb = L.lowerExprExpecting(cbArg, funcOf([], VOID));
      if (cb.type.kind !== "func" || cb.type.params.length > 0) {
        L.noLowering("end callbacks with parameters", cbArg, "() => void callbacks are supported");
      }
      flags |= 4;
      tail.push(cb);
    }
    return { kind: "libCall", fn: "writable.end", args: [receiver, numLit(flags, loc), ...tail], type: receiver.type, loc };
  }

  if (member === "cork" || member === "uncork") {
    requireSide(writableSide, member);
    if (args.length !== 0) L.noLowering(`${member} with arguments`, call);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: member === "cork" ? "writable.cork" : "writable.uncork", args: [receiver], type: VOID, loc };
  }

  if (member === "setEncoding") {
    requireSide(readableSide, "setEncoding");
    if (args.length !== 1) {
      L.noLowering(`setEncoding with ${args.length} arguments`, call, "one literal encoding is the supported form");
    }
    const enc = bufEncoding(L, "setEncoding", args[0]!);
    const receiver = L.lowerExpr(access.expression);
    return { kind: "libCall", fn: "readable.setEncoding", args: [receiver, strLit(enc, loc)], type: receiver.type, loc };
  }

  if (member === "setDefaultEncoding") {
    // The write-side default: utf8 IS the default — admit it; other
    // encodings would change what write(string) means.
    requireSide(writableSide, "setDefaultEncoding");
    const t = args[0] ? L.typeOf(args[0]) : null;
    if (t?.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) {
      return L.lowerExpr(access.expression);
    }
    L.noLowering(
      "setDefaultEncoding",
      call,
      "utf8 (the default, as a compile-time literal) is the supported write-side string encoding",
    );
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
  "ended", "endEmitted", "destroyed", "errorEmitted", "emittedReadable",
  "needReadable", "reading", "readableListening", "resumeScheduled",
  "objectMode", "constructed", "closed",
]);
const RS_NUM_PROPS: ReadonlySet<string> = new Set(["length", "highWaterMark"]);
const WS_BOOL_PROPS: ReadonlySet<string> = new Set([
  "ended", "ending", "finished", "destroyed", "errorEmitted", "needDrain",
  "objectMode", "constructed", "closed", "prefinished",
]);
const WS_NUM_PROPS: ReadonlySet<string> = new Set([
  "length", "highWaterMark", "corked", "bufferedRequestCount",
]);

export function lowerStreamStateProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr | null {
  if (expr.questionDotToken) return null;
  const inner = expr.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.questionDotToken) return null;
  const stateName = inner.name.text;
  if (stateName !== "_readableState" && stateName !== "_writableState") return null;
  let recvT: IrType | null;
  try {
    recvT = L.mapTypeOf(L.typeOf(inner.expression));
  } catch {
    return null;
  }
  if (recvT?.kind !== "object") return null;
  const info = L.classes.get(recvT.className);
  const sides = streamSidesOf(L, info);
  if (!sides) return null;
  const loc = locOf(expr);
  const readable = stateName === "_readableState";
  if (readable ? sides === "w" : sides === "r") {
    L.noLowering(`${stateName} on a ${recvT.className.slice(1)} (that half is absent)`, expr);
  }
  const name = expr.name.text;
  const prefix = readable ? "rs:" : "ws:";
  const receiver = () => L.lowerExpr(inner.expression);
  if (name === "flowing" && readable) {
    const type: IrType = unionOf(L, [BOOL, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "readable.flowing", args: [receiver()], type, loc };
    return L.maybeNarrow(read, expr);
  }
  if (name === "errored") {
    const type: IrType = unionOf(L, [{ kind: "object", className: "%Error" }, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "stream.errored", args: [receiver()], type, loc };
    return L.maybeNarrow(read, expr);
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
  L.noLowering(
    `reading ${stateName}.${name}`,
    expr,
    "the lowered internal-state view covers the scalar fields (length, ended, flowing, errorEmitted, ...) — object-valued members like pipes and buffered entries have no lowering",
  );
}

/* ── the property surface ─────────────────────────────────────────────── */

const READABLE_BOOL_PROPS: ReadonlySet<string> = new Set(["readable", "readableEnded"]);
const WRITABLE_BOOL_PROPS: ReadonlySet<string> = new Set(["writable", "writableEnded", "writableFinished", "writableNeedDrain"]);
const SHARED_BOOL_PROPS: ReadonlySet<string> = new Set(["destroyed", "closed"]);
const READABLE_NUM_PROPS: ReadonlySet<string> = new Set(["readableLength", "readableHighWaterMark"]);
const WRITABLE_NUM_PROPS: ReadonlySet<string> = new Set(["writableLength", "writableHighWaterMark", "writableCorked"]);

/** Property reads on stream-rooted receivers (`r.readableEnded`,
 * `w.destroyed`, ...). Null for names this spoke does not own. */
export function lowerStreamProperty(L: Lowerer, expr: ts.PropertyAccessExpression, info: ClassInfo): IrExpr | null {
  const sides = streamSidesOf(L, info);
  if (!sides) return null;
  const name = expr.name.text;
  const loc = locOf(expr);
  const readableSide = sides === "r" || sides === "rw";
  const writableSide = sides === "w" || sides === "rw";

  const propCall = (type: IrType): IrExpr => ({
    kind: "libCall",
    fn: "stream.prop",
    args: [L.lowerExpr(expr.expression), strLit(name, loc)],
    type,
    loc,
  });

  if ((readableSide && READABLE_BOOL_PROPS.has(name)) || (writableSide && WRITABLE_BOOL_PROPS.has(name)) || SHARED_BOOL_PROPS.has(name)) {
    return propCall(BOOL);
  }
  if ((readableSide && READABLE_NUM_PROPS.has(name)) || (writableSide && WRITABLE_NUM_PROPS.has(name))) {
    return propCall(F64);
  }
  if (name === "readableFlowing" && readableSide) {
    const type: IrType = unionOf(L, [BOOL, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "readable.flowing", args: [L.lowerExpr(expr.expression)], type, loc };
    return L.maybeNarrow(read, expr);
  }
  if (name === "errored") {
    const type: IrType = unionOf(L, [{ kind: "object", className: "%Error" }, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "stream.errored", args: [L.lowerExpr(expr.expression)], type, loc };
    return L.maybeNarrow(read, expr);
  }
  if (name === "readableObjectMode" && readableSide) {
    // Runtime state: Readable.from streams answer true (object entries).
    return propCall(BOOL);
  }
  if (name === "writableObjectMode" && writableSide) {
    // objectMode construction fences, so the answer is compile-time false.
    return boolLit(false, loc);
  }
  if (name === "allowHalfOpen" && sides === "rw") {
    return propCall(BOOL);
  }
  return null;
}
