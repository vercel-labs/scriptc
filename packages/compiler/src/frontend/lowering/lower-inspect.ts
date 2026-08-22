/* The node:util inspect/format lowering (a spoke module like
 * lower-assert.ts): STATIC util.inspect — one synthesized traversal
 * helper per argument type (the deepStrictEqual precedent, interned per
 * typeKey), producing Node v24's byte-exact DEFAULT-options rendering —
 * and util.format/formatWithOptions over compile-time format strings.
 *
 * The division of labor: the synthesized helpers own the TRAVERSAL the
 * static type dictates (fields, elements, entries, union arms, depth
 * bookkeeping); scr_inspect.c owns everything the type cannot know —
 * scalar formatting (-0, the quoting ladder, string splitting), Buffer
 * hex, and the layout engine (frames, break-length, grid grouping).
 * Checked-dynamic values render ENTIRELY in the runtime (the dyn
 * carries its own shape); island `any` values render their scalar kinds
 * and throw catchably on composites (the runtime tag is all there is).
 *
 * Options fence honestly, never approximate: depth takes any numeric
 * literal plus null/Infinity (cycle-capable types are safe unbounded —
 * the circular machinery cuts every cycle), colors:false / compact:3 /
 * breakLength:80 are the accepted no-op spellings, and everything else
 * names itself in the diagnostic. Values whose rendering would need
 * runtime type identity the static type lacks fence the same way: class
 * hierarchies (a subclass's name and extra fields are dynamic), function
 * values inside composites (no runtime name exists), Uint8Array-vs-
 * Buffer ambiguity.
 *
 * CYCLIC runtime data renders Node's exact `<ref *N>`/`[Circular *N]`
 * markers: helpers over cycle-capable composites (typeReachesItself)
 * drive the runtime seen/circular protocol (insp.circCheck/seenPush/
 * refWrap — scr_inspect.c), numbering in discovery order per top-level
 * value, exactly formatValue's ctx.seen/ctx.circular.
 *
 * Known-divergence corners (SEMANTICS.md): errors render the STACKLESS
 * `[Name: message]` form (compiled binaries carry no JS stack), and
 * record/class property order follows declaration order (SEMANTICS.md
 * 36's existing stance). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { isJsSourceFile } from "../program.js";
import { BOOL, DYN, F64, IrExpr, IrStmt, IrType, RUNTIME_ERROR_CLASSES, STRING, SrcLoc, canConvertToDyn, canDynCheckTo, shapeHasAccessorSlots, typeKey } from "../../ir/nodes.js";
import type { ClassInfo } from "./lower-classes.js";
import { pureReemittable } from "./lower-exprs.js";

/* ── IR construction shorthand ───────────────────────────────────────── */

const str = (value: string, loc: SrcLoc): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const num = (value: number, loc: SrcLoc): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const boolLit = (value: boolean, loc: SrcLoc): IrExpr => ({ kind: "boolLit", value, type: BOOL, loc });

function concatAll(parts: IrExpr[], loc: SrcLoc): IrExpr {
  if (parts.length === 0) return str("", loc);
  let out = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    out = { kind: "strConcat", left: out, right: parts[i]!, type: STRING, loc };
  }
  return out;
}

/* ── property-name rendering (compile-time keys) ─────────────────────── */

/** strEscape's quote ladder over a COMPILE-TIME string (record field
 * names, format-string chunks never pass through here — only keys).
 * Mirrors scr_inspect.c's insp_quote_into byte-for-byte. */
function inspectQuote(s: string): string {
  const hasSingle = s.includes("'");
  const quote = !hasSingle ? "'" : !s.includes('"') ? '"' : !s.includes("`") && !s.includes("${") ? "`" : "'";
  let body = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) {
      const meta = ["\\b", "\\t", "\\n", undefined, "\\f", "\\r"][c - 8];
      body += c >= 8 && c <= 13 && meta !== undefined ? meta : `\\x${c.toString(16).toUpperCase().padStart(2, "0")}`;
    } else if (c === 0x27 && quote === "'") {
      body += "\\'";
    } else if (c === 0x5c) {
      body += "\\\\";
    } else if (c >= 0x7f && c <= 0x9f) {
      body += `\\x${c.toString(16).toUpperCase().padStart(2, "0")}`;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        body += s[i]! + s[i + 1]!;
        i++;
      } else {
        body += `\\u${c.toString(16)}`;
      }
    } else {
      body += s[i]!;
    }
  }
  return quote + body + quote;
}

/** formatProperty's key rendering: bare identifiers stay bare
 * ('__proto__' excepted), everything else quotes. */
function inspectKey(name: string): string {
  if (name === "__proto__") return "['__proto__']";
  return /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name) ? name : inspectQuote(name);
}

/* ── type support ────────────────────────────────────────────────────── */

/** The error-hierarchy gate: `info`'s instances render through the
 * runtime's name/message/code slots, which subclasses inherit — sound
 * only when NO descendant adds declared fields (they would be own
 * properties Node prints). */
function errorRenderable(info: ClassInfo): boolean {
  // The builtin classes' name/message/code live in runtime slots (the
  // ScrError prefix insp.error reads), not IR fields; only USER-declared
  // fields are own properties the runtime rendering would miss. #private
  // fields are NOT own properties — Node never prints them — so they
  // don't disqualify.
  if (!info.builtinError && info.def.fields.some((f) => !f.name.startsWith("#"))) return false;
  return info.subclasses.every((s) => errorRenderable(s));
}

function isErrorClass(L: Lowerer, className: string): boolean {
  if (RUNTIME_ERROR_CLASSES.has(className)) return true;
  return L.isSubclassOf(className, "%Error");
}

/** inspUnsupportedReason: the deepUnsupportedReason twin. Fences name the
 * FIRST unsupported constituent. `visiting` terminates recursive shapes
 * and records their existence (the depth-null gate). */
function inspectSupport(L: Lowerer, t: IrType, visiting: Set<string>, out: { recursive: boolean }): string | null {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "undefinedT":
    case "nullT":
    case "regex":
    case "symbol":
    case "dyn":
    case "jsval":
      return null;
    case "array":
      return inspectSupport(L, t.elem, visiting, out);
    case "bytes":
      return "typed arrays inside composites have no inspect lowering yet (Buffer's <Buffer ..> form vs Uint8Array's is not recorded in the static type here)";
    case "record": {
      if (visiting.has(t.shapeId)) {
        out.recursive = true;
        return null;
      }
      visiting.add(t.shapeId);
      const shape = L.shapes.get(t.shapeId);
      if (!shape) return "this record shape has no inspect lowering";
      // Accessor-carrying shapes: Node prints the accessor names as
      // `x: [Getter]` / `[Setter]` / `[Getter/Setter]` in insertion order
      // — a position the static field walk does not track (accessor slots
      // live outside declaredOrder), so the render fences by name.
      if (shapeHasAccessorSlots(shape)) {
        return "shapes carrying get/set accessor properties have no inspect lowering yet (Node prints the accessor names as [Getter]/[Setter] in insertion order — read the properties explicitly)";
      }
      if (shape.indexValue !== undefined) {
        // PURE index-signature shapes (Record<string, V> — no declared
        // fields) render like the dyn's objects: a runtime key walk
        // (recordOvfKeys), each key through insp.key's bare-or-quoted
        // ladder. Hybrids keep the fence — JS orders integer keys first
        // ACROSS the declared and overflow stores, an interleave the
        // declared-then-overflow walk cannot honor.
        if (shape.fields.length > 0) {
          return "index-signature records with declared fields have no inspect lowering yet (JS interleaves integer keys across the declared and dynamic key sets)";
        }
        const why = inspectSupport(L, shape.indexValue, visiting, out);
        if (why !== null) return why;
        visiting.delete(t.shapeId);
        return null;
      }
      for (const f of shape.fields) {
        const why = inspectSupport(L, f.type, visiting, out);
        if (why !== null) return why;
      }
      visiting.delete(t.shapeId);
      return null;
    }
    case "map": {
      const keyWhy = inspectSupport(L, t.key, visiting, out);
      if (keyWhy !== null) return keyWhy;
      return inspectSupport(L, t.value, visiting, out);
    }
    case "set":
      return inspectSupport(L, t.elem, visiting, out);
    case "union": {
      const def = L.unions.get(t.unionId);
      if (!def) return "this union has no inspect lowering";
      if (visiting.has(t.unionId)) {
        out.recursive = true;
        return null;
      }
      visiting.add(t.unionId);
      for (const arm of def.arms) {
        const why = inspectSupport(L, arm, visiting, out);
        if (why !== null) return why;
      }
      visiting.delete(t.unionId);
      return null;
    }
    case "func":
      return "function values have no inspect lowering (no runtime name exists — Node prints '[Function: name]'; pass the function's declared identifier directly to util.inspect for the baked form)";
    case "object": {
      const info = L.classes.get(t.className);
      if (!info) return `class '${t.className}' has no inspect lowering`;
      if (isErrorClass(L, t.className)) {
        return errorRenderable(info)
          ? null
          : "error subclasses with declared fields have no inspect lowering yet (the extra own properties are runtime-dynamic)";
      }
      if (info.subclasses.length > 0) {
        return `inspect of '${t.className}' values is not lowered (the class has subclasses — the runtime value's constructor name and fields are dynamic)`;
      }
      if (visiting.has(t.className)) {
        out.recursive = true;
        return null;
      }
      visiting.add(t.className);
      // #private fields never print (Node omits them — not own
      // properties), so their types don't gate support.
      for (const f of info.def.fields) {
        if (f.name.startsWith("#")) continue;
        const why = inspectSupport(L, f.type, visiting, out);
        if (why !== null) return why;
      }
      visiting.delete(t.className);
      return null;
    }
    default:
      return `'${L.fmt(t)}' values have no inspect lowering`;
  }
}

/* ── the per-type rendering expression ───────────────────────────────── */

/** True when a runtime value of `t` at index expr `v` answers
 * `typeof v === 'number'` — the grid-grouping order flag. */
function isNumberFlag(L: Lowerer, t: IrType, v: () => IrExpr, loc: SrcLoc): IrExpr {
  if (t.kind === "f64") return boolLit(true, loc);
  if (t.kind === "union") {
    const def = L.unions.get(t.unionId);
    const tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
    if (tag >= 0) {
      return { kind: "unionIsTag", unionId: t.unionId, tag, negated: false, value: v(), type: BOOL, loc };
    }
  }
  return boolLit(false, loc);
}

/** The rendering of one value of type `t` at runtime depth `recurse`
 * with the depth budget `depth` — a direct scalar libCall or a call of
 * the interned per-type helper. */
function inspectExpr(
  L: Lowerer,
  t: IrType,
  value: IrExpr,
  recurse: IrExpr,
  depth: IrExpr,
  loc: SrcLoc,
): IrExpr {
  switch (t.kind) {
    case "f64":
      return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
    case "string":
      return { kind: "libCall", fn: "insp.str", args: [value], type: STRING, loc };
    case "bool":
      return { kind: "toString", operand: value, type: STRING, loc };
    case "undefinedT":
      return str("undefined", loc);
    case "nullT":
      return str("null", loc);
    case "regex":
      return { kind: "libCall", fn: "insp.regex", args: [value], type: STRING, loc };
    case "symbol":
      // inspect(sym) IS Symbol.prototype.toString's text ("Symbol(foo)")
      // — Node prints it unquoted at every depth.
      return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc };
    case "bytes":
      return { kind: "libCall", fn: "insp.buffer", args: [value], type: STRING, loc };
    case "dyn":
      return { kind: "libCall", fn: "insp.dyn", args: [value, recurse, depth], type: STRING, loc };
    case "jsval":
      return { kind: "libCall", fn: "insp.jsval", args: [value, recurse, depth], type: STRING, loc };
    case "object":
      if (isErrorClass(L, t.className)) {
        return { kind: "libCall", fn: "insp.error", args: [value, recurse, depth], type: STRING, loc };
      }
      return { kind: "call", callee: inspectHelper(L, t, loc), args: [value, recurse, depth], type: STRING, loc };
    default:
      return { kind: "call", callee: inspectHelper(L, t, loc), args: [value, recurse, depth], type: STRING, loc };
  }
}

/** True when a VALUE of `t` can contain itself — t's type graph reaches t
 * again through record fields (index values included), array elements,
 * union arms, map keys/values, set elements, or class fields. Inspect
 * helpers over such types run Node's circular machinery (seen stack +
 * <ref *N>/[Circular *N]); everything acyclic keeps the zero-cost path
 * (a value of an acyclic type can never repeat on its own path). */
export function typeReachesItself(L: Lowerer, t: IrType): boolean {
  const root = typeKey(t);
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    const constituents: IrType[] = [];
    switch (u.kind) {
      case "record": {
        const shape = L.shapes.get(u.shapeId);
        if (!shape) return false;
        constituents.push(...shape.fields.map((f) => f.type));
        if (shape.indexValue) constituents.push(shape.indexValue);
        break;
      }
      case "array":
      case "set":
        constituents.push(u.elem);
        break;
      case "map":
        constituents.push(u.key, u.value);
        break;
      case "union": {
        const def = L.unions.get(u.unionId);
        if (def) constituents.push(...def.arms);
        break;
      }
      case "object": {
        const info = L.classes.get(u.className);
        if (info) constituents.push(...info.def.fields.map((f) => f.type));
        break;
      }
      default:
        return false;
    }
    for (const c of constituents) {
      const k = typeKey(c);
      if (k === root) return true;
      if (!seen.has(k)) {
        seen.add(k);
        if (walk(c)) return true;
      }
    }
    return false;
  };
  return walk(t);
}

/* ── the interned per-type helper ────────────────────────────────────── */

/** `%util.insp.<n>(v, r, d): string` — formatValue over the static type:
 * empty composites answer their literals (before the depth check, Node's
 * order), the depth budget answers `[Array]`/`[Object]`/`[Map]`/
 * `[Set]`/`[ClassName]`, and non-empty composites drive the runtime
 * frame engine (begin / entry / end). Registered in the cache BEFORE the
 * body builds, so recursive shapes call themselves by name. */
function inspectHelper(L: Lowerer, t: IrType, loc: SrcLoc): string {
  const key = `insp:${typeKey(t)}`;
  const existing = L.inspectHelpers.get(key);
  if (existing) return existing;
  const name = `%util.insp.${L.inspectHelpers.size}`;
  L.inspectHelpers.set(key, name);

  const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
  const v = (): IrExpr => ref("v.0", t);
  const r = (): IrExpr => ref("r.0", F64);
  const d = (): IrExpr => ref("d.0", F64);
  const rPlus1 = (): IrExpr => ({ kind: "bin", op: "+", left: r(), right: num(1, loc), type: F64, loc });
  const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
  const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
  // CYCLE-CAPABLE composites (typeReachesItself) run Node's circular
  // machinery: circCheck first (a value already on the traversal stack
  // renders [Circular *N] — before the empty/depth answers, Node's
  // order), seen-push after begin, and refWrap around end's result (the
  // <ref *N> prefix on values the walk found circular). Acyclic types
  // keep the zero-cost path.
  const onCycle =
    (t.kind === "record" || t.kind === "array" || t.kind === "map" || t.kind === "object") &&
    typeReachesItself(L, t);
  const begin = (): IrStmt[] => [
    exprStmt({ kind: "libCall", fn: "insp.begin", args: [rPlus1()], type: { kind: "void" }, loc }),
    ...(onCycle
      ? [exprStmt({ kind: "libCall", fn: "insp.seenPush", args: [v()], type: { kind: "void" }, loc })]
      : []),
  ];
  const entry = (s: IrExpr, isNum: IrExpr): IrStmt =>
    exprStmt({ kind: "libCall", fn: "insp.entry", args: [s, isNum], type: { kind: "void" }, loc });
  const end = (base: IrExpr, b0: IrExpr, b1: IrExpr, arrayExtras: boolean, trailingMore: IrExpr): IrExpr => {
    const reduced: IrExpr = {
      kind: "libCall",
      fn: "insp.end",
      args: [base, b0, b1, rPlus1(), boolLit(arrayExtras, loc), trailingMore],
      type: STRING,
      loc,
    };
    if (!onCycle) return reduced;
    return { kind: "libCall", fn: "insp.refWrap", args: [v(), reduced], type: STRING, loc };
  };
  /** if (r > d) return "<placeholder>"; */
  const depthGate = (placeholder: string): IrStmt => ({
    kind: "if",
    cond: { kind: "bin", op: ">", left: r(), right: d(), type: BOOL, loc },
    then: [ret(str(placeholder, loc))],
    else_: null,
    loc,
  });
  const child = (elemT: IrType, value: IrExpr): IrExpr => inspectExpr(L, elemT, value, rPlus1(), d(), loc);

  const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
    { id: "v.0", name: "v", type: t, mutable: false },
    { id: "r.0", name: "r", type: F64, mutable: false },
    { id: "d.0", name: "d", type: F64, mutable: false },
  ];
  let body: IrStmt[] = [];
  let rebuildShapeOrderBody: (() => void) | null = null;

  switch (t.kind) {
    case "array": {
      const len = (): IrExpr => ({ kind: "arrIntrinsic", method: "length", receiver: v(), args: [], type: F64, loc });
      const at = (i: IrExpr): IrExpr => ({ kind: "arrayGet", arr: v(), index: i, type: t.elem, loc });
      locals.push(
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "s.0", name: "s", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
      );
      const n = (): IrExpr => ref("n.0", F64);
      const shown = (): IrExpr => ref("s.0", F64);
      const i = (): IrExpr => ref("i.0", F64);
      const hasMore = (): IrExpr => ({ kind: "bin", op: ">", left: n(), right: num(100, loc), type: BOOL, loc });
      body = [
        { kind: "varDecl", localId: "n.0", init: len(), loc },
        {
          kind: "if",
          cond: { kind: "bin", op: "===", left: n(), right: num(0, loc), type: BOOL, loc },
          then: [ret(str("[]", loc))],
          else_: null,
          loc,
        },
        depthGate("[Array]"),
        { kind: "varDecl", localId: "s.0", init: { kind: "ternary", cond: hasMore(), then: num(100, loc), else_: n(), type: F64, loc }, loc },
        ...begin(),
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0, loc), loc },
          cond: { kind: "bin", op: "<", left: i(), right: shown(), type: BOOL, loc },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: i(), right: num(1, loc), type: F64, loc }, loc },
          body: [entry(child(t.elem, at(i())), isNumberFlag(L, t.elem, () => at(i()), loc))],
          loc,
        },
        {
          kind: "if",
          cond: hasMore(),
          then: [
            entry(
              {
                kind: "libCall",
                fn: "insp.moreItems",
                args: [{ kind: "bin", op: "-", left: n(), right: num(100, loc), type: F64, loc }],
                type: STRING,
                loc,
              },
              isNumberFlag(L, t.elem, () => at(num(100, loc)), loc),
            ),
          ],
          else_: null,
          loc,
        },
        ret(end(str("", loc), str("[", loc), str("]", loc), true, hasMore())),
      ];
      break;
    }
    case "record": {
      const shape = L.shapes.get(t.shapeId);
      if (!shape) throw new Error(`inspect of unknown shape ${t.shapeId}`);
      const get = (field: string, type: IrType): IrExpr => ({ kind: "recordGet", obj: v(), shapeId: t.shapeId, field, type, loc });
      if (shape.tuple) {
        // Tuples ARE arrays to Node: bracket form, array-extras grouping.
        if (shape.fields.length === 0) {
          body = [ret(str("[]", loc))];
          break;
        }
        body = [depthGate("[Array]"), ...begin()];
        for (const f of shape.fields) {
          body.push(entry(child(f.type, get(f.name, f.type)), isNumberFlag(L, f.type, () => get(f.name, f.type), loc)));
        }
        body.push(ret(end(str("", loc), str("[", loc), str("]", loc), true, boolLit(false, loc))));
        break;
      }
      if (shape.indexValue && shape.fields.length === 0) {
        // The PURE index-signature shape (Record<string, V>): a runtime
        // key walk in insertion order (recordOvfKeys — SEMANTICS.md 36's
        // key-order stance), each key rendered through insp.key's
        // bare-or-quoted ladder, each value read back through the keyed
        // get. No 100-entry cap: Node truncates arrays and iterables,
        // never plain objects.
        const iv = shape.indexValue;
        const ksT: IrType = { kind: "array", elem: STRING };
        locals.push(
          { id: "ks.0", name: "ks", type: ksT, mutable: false },
          { id: "n.0", name: "n", type: F64, mutable: false },
          { id: "i.0", name: "i", type: F64, mutable: true },
          { id: "k.0", name: "k", type: STRING, mutable: false },
        );
        const ks = (): IrExpr => ref("ks.0", ksT);
        const n = (): IrExpr => ref("n.0", F64);
        const i = (): IrExpr => ref("i.0", F64);
        const k = (): IrExpr => ref("k.0", STRING);
        const keyedRead = (): IrExpr =>
          ({ kind: "recordKeyGet", obj: v(), shapeId: t.shapeId, key: k(), overflowOnly: true, type: iv, loc });
        body = [
          { kind: "varDecl", localId: "ks.0", init: { kind: "recordOvfKeys", obj: v(), shapeId: t.shapeId, type: ksT, loc }, loc },
          { kind: "varDecl", localId: "n.0", init: { kind: "arrIntrinsic", method: "length", receiver: ks(), args: [], type: F64, loc }, loc },
          {
            kind: "if",
            cond: { kind: "bin", op: "===", left: n(), right: num(0, loc), type: BOOL, loc },
            then: [ret(str("{}", loc))],
            else_: null,
            loc,
          },
          depthGate("[Object]"),
          ...begin(),
          {
            kind: "for",
            init: { kind: "varDecl", localId: "i.0", init: num(0, loc), loc },
            cond: { kind: "bin", op: "<", left: i(), right: n(), type: BOOL, loc },
            update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: i(), right: num(1, loc), type: F64, loc }, loc },
            body: [
              { kind: "varDecl", localId: "k.0", init: { kind: "arrayGet", arr: ks(), index: i(), type: STRING, loc }, loc },
              entry(
                concatAll(
                  [
                    { kind: "libCall", fn: "insp.key", args: [k()], type: STRING, loc },
                    str(": ", loc),
                    child(iv, keyedRead()),
                  ],
                  loc,
                ),
                boolLit(false, loc),
              ),
            ],
            loc,
          },
          ret(end(str("", loc), str("{", loc), str("}", loc), false, boolLit(false, loc))),
        ];
        break;
      }
      if (shape.fields.length === 0) {
        body = [ret(str("{}", loc))];
        break;
      }
      // Object.keys' declared order (SEMANTICS.md 36's stance). Retained
      // reachability can settle this shape after the helper is first
      // interned, so rebuild the field walk once metadata is final.
      rebuildShapeOrderBody = (): void => {
        const current = L.shapes.get(t.shapeId) ?? shape;
        const order = current.declaredOrder ?? current.fields.map((f) => f.name);
        const byName = new Map(current.fields.map((f) => [f.name, f.type] as const));
        body = [depthGate("[Object]"), ...begin()];
        for (const fname of order) {
          const ft = byName.get(fname);
          if (!ft) continue;
          body.push(
            entry(
              concatAll([str(`${inspectKey(fname)}: `, loc), child(ft, get(fname, ft))], loc),
              boolLit(false, loc),
            ),
          );
        }
        body.push(ret(end(str("", loc), str("{", loc), str("}", loc), false, boolLit(false, loc))));
      };
      rebuildShapeOrderBody();
      break;
    }
    case "map":
    case "set": {
      const isMap = t.kind === "map";
      const mi = (method: string, args: IrExpr[], type: IrType): IrExpr =>
        isMap
          ? ({ kind: "mapIntrinsic", method: method as "size", receiver: v(), args, type, loc } as IrExpr)
          : ({ kind: "setIntrinsic", method: method as "size", receiver: v(), args, type, loc } as IrExpr);
      locals.push(
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "c.0", name: "c", type: F64, mutable: true },
      );
      const n = (): IrExpr => ref("n.0", F64);
      const i = (): IrExpr => ref("i.0", F64);
      const c = (): IrExpr => ref("c.0", F64);
      const label = isMap ? "Map" : "Set";
      const keyT = isMap ? (t as IrType & { kind: "map" }).key : (t as IrType & { kind: "set" }).elem;
      const hasMore = (): IrExpr => ({ kind: "bin", op: ">", left: n(), right: num(100, loc), type: BOOL, loc });
      const entryValue = (): IrExpr => {
        const k = child(keyT, mi("iterKey", [i()], keyT));
        if (!isMap) return k;
        const valueT = (t as IrType & { kind: "map" }).value;
        return concatAll([k, str(" => ", loc), child(valueT, mi("iterValue", [i()], valueT))], loc);
      };
      body = [
        { kind: "varDecl", localId: "n.0", init: mi("size", [], F64), loc },
        {
          kind: "if",
          cond: { kind: "bin", op: "===", left: n(), right: num(0, loc), type: BOOL, loc },
          then: [ret(str(`${label}(0) {}`, loc))],
          else_: null,
          loc,
        },
        depthGate(`[${label}]`),
        ...begin(),
        { kind: "varDecl", localId: "c.0", init: num(0, loc), loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: num(0, loc), loc },
          cond: { kind: "bin", op: "<", left: i(), right: mi("iterCount", [], F64), type: BOOL, loc },
          update: { kind: "assign", localId: "i.0", value: { kind: "bin", op: "+", left: i(), right: num(1, loc), type: F64, loc }, loc },
          body: [
            {
              kind: "if",
              cond: { kind: "unary", op: "!", operand: mi("iterLive", [i()], BOOL), type: BOOL, loc },
              then: [{ kind: "continue", loc }],
              else_: null,
              loc,
            },
            {
              kind: "if",
              cond: { kind: "bin", op: "===", left: c(), right: num(100, loc), type: BOOL, loc },
              then: [{ kind: "break", loc }],
              else_: null,
              loc,
            },
            entry(entryValue(), boolLit(false, loc)),
            { kind: "assign", localId: "c.0", value: { kind: "bin", op: "+", left: c(), right: num(1, loc), type: F64, loc }, loc },
          ],
          loc,
        },
        {
          kind: "if",
          cond: hasMore(),
          then: [
            entry(
              {
                kind: "libCall",
                fn: "insp.moreItems",
                args: [{ kind: "bin", op: "-", left: n(), right: num(100, loc), type: F64, loc }],
                type: STRING,
                loc,
              },
              boolLit(false, loc),
            ),
          ],
          else_: null,
          loc,
        },
        ret(
          end(
            str("", loc),
            concatAll([str(`${label}(`, loc), { kind: "toString", operand: n(), type: STRING, loc }, str(") {", loc)], loc),
            str("}", loc),
            false,
            hasMore(),
          ),
        ),
      ];
      break;
    }
    case "union": {
      const def = L.unions.get(t.unionId);
      if (!def) throw new Error(`inspect of unknown union ${t.unionId}`);
      body = [];
      def.arms.forEach((arm, tag) => {
        // The union wrapper is not a nesting level: arms render at the
        // SAME recursion depth (formatValue dispatches on the value).
        const narrowed: IrExpr = { kind: "unionNarrow", unionId: t.unionId, tag, value: v(), type: arm, loc };
        body.push({
          kind: "if",
          cond: { kind: "unionIsTag", unionId: t.unionId, tag, negated: false, value: v(), type: BOOL, loc },
          then: [ret(inspectExpr(L, arm, narrowed, r(), d(), loc))],
          else_: null,
          loc,
        });
      });
      body.push(ret(str("", loc))); // unreachable: some arm always matches
      break;
    }
    case "object": {
      const info = L.classes.get(t.className);
      if (!info) throw new Error(`inspect of unknown class ${t.className}`);
      // Node prints the class's OWN name — the declaration's, never the
      // IR name's module qualifier (`m0.Timer` is the frontend's spelling
      // for a class declared in a non-entry module).
      const display = info.decl?.name?.text ?? info.def.name.replace(/^%/, "");
      // #private fields never render: they are not properties in any
      // observable way — Node's inspect omits them entirely (verified),
      // so a class whose only fields are private prints as `C {}`.
      const visible = info.def.fields.filter((f) => !f.name.startsWith("#"));
      if (visible.length === 0) {
        body = [ret(str(`${display} {}`, loc))];
        break;
      }
      const get = (field: string, type: IrType): IrExpr => ({ kind: "fieldGet", obj: v(), className: t.className, field, type, loc });
      body = [depthGate(`[${display}]`), ...begin()];
      // def.fields carries layout order: the base chain first, then own —
      // exactly the own-property insertion order of a constructor that
      // assigns in declaration order (SEMANTICS.md 36's stance). SYMBOL-
      // keyed fields render LAST ([[OwnPropertyKeys]] lists all string
      // keys before all symbol keys — Node's inspect order) and their
      // layout name IS Node's key spelling (`Symbol(limit)`), printed
      // verbatim, never quoted.
      const symNames = new Set(info.symbolFields?.values() ?? []);
      const ordered = [
        ...visible.filter((f) => !symNames.has(f.name)),
        ...visible.filter((f) => symNames.has(f.name)),
      ];
      for (const f of ordered) {
        const key = symNames.has(f.name) ? f.name : inspectKey(f.name);
        body.push(
          entry(concatAll([str(`${key}: `, loc), child(f.type, get(f.name, f.type))], loc), boolLit(false, loc)),
        );
      }
      body.push(ret(end(str("", loc), str(`${display} {`, loc), str("}", loc), false, boolLit(false, loc))));
      break;
    }
    default:
      throw new Error(`inspect helper over unexpected type ${typeKey(t)}`);
  }

  let prependCycleGuard: (() => void) | null = null;
  if (onCycle) {
    // The circular check, FIRST (before the empty-literal and depth
    // answers): a value already on the traversal stack renders
    // [Circular *N] and descends no further — Node's formatValue order
    // (a circular target beyond the depth budget still says Circular).
    locals.push({ id: "cc.0", name: "cc", type: F64, mutable: false });
    const cc = (): IrExpr => ref("cc.0", F64);
    prependCycleGuard = (): void => {
      body.unshift(
        {
          kind: "varDecl",
          localId: "cc.0",
          init: { kind: "libCall", fn: "insp.circCheck", args: [v()], type: F64, loc },
          loc,
        },
        {
          kind: "if",
          cond: { kind: "bin", op: ">", left: cc(), right: num(0, loc), type: BOOL, loc },
          then: [ret({ kind: "libCall", fn: "insp.circular", args: [cc()], type: STRING, loc })],
          else_: null,
          loc,
        },
      );
    };
    prependCycleGuard();
  }

  const fn = {
    name,
    params: [
      { localId: "v.0", name: "v", type: t },
      { localId: "r.0", name: "r", type: F64 },
      { localId: "d.0", name: "d", type: F64 },
    ],
    returnType: STRING,
    locals,
    body,
    loc,
  };
  if (rebuildShapeOrderBody !== null) {
    L.shapeOrderHelperFinalizers.push(() => {
      rebuildShapeOrderBody!();
      prependCycleGuard?.();
      fn.body = body;
    });
  }
  L.liftedFns.push(fn);
  return name;
}

/* ── the console/format top-level value rendering ────────────────────── */

/** Node's formatWithOptions REST-ARG rule over one statically-typed value
 * (console.log's non-format arguments, util.format's %s and trailing
 * arguments): a STRING prints VERBATIM — never quote-wrapped, the classic
 * console.log vs inspect distinction — and every other kind renders
 * exactly as inspect at the given depth. Unions dispatch per arm AT
 * RUNTIME through an interned helper, so a string arm stays verbatim
 * while its sibling arms inspect. Callers check inspectSupport first. */
function formatValueExpr(L: Lowerer, t: IrType, value: IrExpr, depth: number, loc: SrcLoc): IrExpr {
  switch (t.kind) {
    case "string":
      return value;
    case "f64":
      return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
    case "bool":
      return { kind: "toString", operand: value, type: STRING, loc };
    case "undefinedT":
      return str("undefined", loc);
    case "nullT":
      return str("null", loc);
    case "symbol":
      return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc };
    case "dyn":
      return { kind: "libCall", fn: "insp.dynS", args: [value, num(depth, loc)], type: STRING, loc };
    case "union":
      return { kind: "call", callee: formatUnionHelper(L, t, depth, loc), args: [value], type: STRING, loc };
    default:
      return inspectExpr(L, t, value, num(0, loc), num(depth, loc), loc);
  }
}

/** `%util.fmtv.<n>(v): string` — formatValueExpr's runtime dispatch over a
 * union's arms (interned per union + depth, the inspectHelper pattern).
 * The TOP-LEVEL union rule only: nested unions inside composites keep
 * inspect's own rendering, where string arms quote — exactly Node. */
function formatUnionHelper(L: Lowerer, t: IrType & { kind: "union" }, depth: number, loc: SrcLoc): string {
  const key = `fmtv:${typeKey(t)}:${depth}`;
  const existing = L.inspectHelpers.get(key);
  if (existing) return existing;
  const name = `%util.fmtv.${L.inspectHelpers.size}`;
  L.inspectHelpers.set(key, name);
  const def = L.unions.get(t.unionId);
  if (!def) throw new Error(`format value over unknown union ${t.unionId}`);
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: t, loc });
  const body: IrStmt[] = [];
  def.arms.forEach((arm, tag) => {
    const narrowed: IrExpr = { kind: "unionNarrow", unionId: t.unionId, tag, value: v(), type: arm, loc };
    body.push({
      kind: "if",
      cond: { kind: "unionIsTag", unionId: t.unionId, tag, negated: false, value: v(), type: BOOL, loc },
      then: [{ kind: "return", value: formatValueExpr(L, arm, narrowed, depth, loc), loc }],
      else_: null,
      loc,
    });
  });
  body.push({ kind: "return", value: str("", loc), loc }); // unreachable: some arm always matches
  L.liftedFns.push({
    name,
    params: [{ localId: "v.0", name: "v", type: t }],
    returnType: STRING,
    locals: [{ id: "v.0", name: "v", type: t, mutable: false }],
    body,
    loc,
  });
  return name;
}

/** One console.log/info/debug/error/warn argument OUTSIDE the direct
 * scalar set (number/string/boolean ride the ScrLogArg protocol
 * untouched, and dyn/function values have their own paths at the call
 * site): the rendered STRING under Node's console semantics — inspect at
 * the rest-args depth 2 — or the honest fence naming the first
 * unsupported constituent. */
export function lowerConsoleInspectArg(
  L: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  surface: string,
  loc: SrcLoc,
): IrExpr {
  const t = value.type;
  if (t.kind === "undefinedT" || t.kind === "nullT") {
    // The baked text ("undefined"/"null"): the operand is a literal or a
    // pure read, so dropping its evaluation loses nothing. Effectful
    // unit-typed operands keep a fence — a silent skip is banned.
    if (value.kind !== "unitLit" && !pureReemittable(value)) {
      L.unsupported(
        "SC1090",
        node,
        `${surface} of an effectful '${L.fmt(t)}'-typed expression (evaluate it first: const v = ...; ${surface}(v))`,
      );
    }
    return str(t.kind === "undefinedT" ? "undefined" : "null", loc);
  }
  if (t.kind === "bytes") {
    // One runtime representation serves Buffer AND Uint8Array; their
    // renderings differ, so the argument's checker type picks — and only
    // Buffer lowers (lowerInspectCall's stance).
    const tname = L.checker.typeToString(L.checker.getBaseTypeOfLiteralType(L.typeOf(node)));
    const isBuffer =
      tname === "Buffer" || tname === "NonSharedBuffer" || tname.startsWith("Buffer<") || tname.startsWith("NonSharedBuffer<");
    if (t.elem !== "u8" || !isBuffer) {
      L.unsupported(
        "SC1090",
        node,
        `${surface} of '${tname}' values (Buffer's <Buffer ..> form is the lowered typed-array rendering; other typed arrays fence)`,
      );
    }
    return inspectExpr(L, t, value, num(0, loc), num(2, loc), loc);
  }
  if (t.kind === "void") {
    // Node prints "undefined" for a void call's result; a void expression
    // is not a value here, so the composition fences with the rewrite.
    L.unsupported(
      "SC1090",
      node,
      `${surface} of a void call result (call it as its own statement, then ${surface}(undefined))`,
    );
  }
  const walk = { recursive: false };
  const reason = inspectSupport(L, t, new Set(), walk);
  if (reason !== null) {
    L.unsupported("SC1090", node, `${surface} of '${L.fmt(t)}' values (${reason})`);
  }
  return formatValueExpr(L, t, value, 2, loc);
}

/* ── the callsite: options, direct function/class names ──────────────── */

/** The parsed options literal: the resolved depth (numeric; Infinity for
 * `null`), with every non-default knob fenced by name. */
function parseInspectOptions(L: Lowerer, node: ts.Expression | undefined, recursive: boolean): number {
  if (!node || (ts.isIdentifier(node) && node.text === "undefined")) return 2;
  if (!ts.isObjectLiteralExpression(node)) {
    L.noLowering(
      "util.inspect with a non-literal options argument",
      node,
      "the options must be an object literal ({ depth, colors: false, ... }) so the knobs resolve at compile time",
    );
  }
  let depth = 2;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      L.noLowering("util.inspect options in this form", prop, "plain `key: literal` entries are the lowered options");
    }
    const key = prop.name.text;
    const value = prop.initializer;
    const numeric = (): number | null => {
      if (ts.isNumericLiteral(value)) return Number(value.text);
      if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) {
        return -Number(value.operand.text);
      }
      return null;
    };
    if (key === "depth") {
      if (value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === "Infinity")) {
        // Unbounded depth is safe over recursive types too: the circular
        // machinery ([Circular *N]) cuts every cycle, so the walk is
        // bounded by the (finite) object graph — exactly Node.
        void recursive;
        depth = Infinity;
      } else if (!(ts.isIdentifier(value) && value.text === "undefined")) {
        const n = numeric();
        if (n === null) {
          L.noLowering("util.inspect with a non-literal depth option", value, "depth must be a numeric literal (or null)");
        }
        depth = n;
      }
    } else if (key === "colors") {
      if (value.kind !== ts.SyntaxKind.FalseKeyword) {
        L.noLowering("util.inspect with colors: true", value, "ANSI styling has no lowering — only colors: false");
      }
    } else if (key === "compact") {
      if (numeric() !== 3) {
        L.noLowering("util.inspect with a non-default compact option", value, "only the default compact: 3 is lowered");
      }
    } else if (key === "breakLength") {
      if (numeric() !== 80) {
        L.noLowering("util.inspect with a non-default breakLength option", value, "only the default breakLength: 80 is lowered");
      }
    } else {
      L.noLowering(
        `util.inspect with the '${key}' option`,
        prop,
        "the lowered options are depth (numeric literal or null), colors: false, compact: 3, and breakLength: 80",
      );
    }
  }
  return depth;
}

/** `util.inspect(fn)` / `util.inspect(Cls)` over a DIRECT identifier
 * naming a declared function or class: the name is compile-time truth,
 * so `[Function: name]` / `[class X extends Y]` bake as literals. Null
 * when the identifier is not such a declaration. */
function directCallableInspect(L: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr | null {
  if (!ts.isIdentifier(node)) return null;
  const sym = L.resolveValueSymbol(node);
  if (!sym) return null;
  const cls = L.classBySymbol.get(sym) ?? L.builtinErrorInfoOf(sym);
  // A rebindable decorated name is not compile-time truth — the binding
  // holds the decoration result; no literal folds.
  if (cls?.classDecorators?.valueGlobalId !== undefined) return null;
  if (cls) {
    if (cls.builtinError) {
      // Node's Error constructors are native functions, not classes.
      return str(`[Function: ${cls.def.name.replace(/^%/, "")}]`, loc);
    }
    const base = cls.base ? ` extends ${cls.base.def.name.replace(/^%/, "")}` : "";
    return str(`[class ${cls.def.name}${base}]`, loc);
  }
  const decl = L.checker.declarationsOf(sym)[0];
  if (!decl) return null;
  if (ts.isFunctionDeclaration(decl) && decl.name) {
    return str(`[Function: ${decl.name.text}]`, loc);
  }
  if (
    ts.isVariableDeclaration(decl) &&
    ts.isIdentifier(decl.name) &&
    decl.initializer &&
    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
  ) {
    // JS name inference: the binding names the function value — unless
    // the function expression carries its OWN name, which wins.
    const own = ts.isFunctionExpression(decl.initializer) ? decl.initializer.name?.text : undefined;
    return str(`[Function: ${own ?? decl.name.text}]`, loc);
  }
  return null;
}

/** util.inspect(value[, options]) — the spoke's inspect entry. */
function lowerInspectCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.length < 1 || expr.arguments.length > 2) {
    L.noLowering(
      `util.inspect with ${expr.arguments.length} arguments`,
      expr,
      "the supported forms are inspect(value) and inspect(value, options)",
    );
  }
  const valueNode = expr.arguments[0]!;
  // Inline function/class literals and direct declared names render as
  // their baked forms; other function-typed values fence below.
  const direct = directCallableInspect(L, valueNode, loc);
  if (direct) {
    parseInspectOptions(L, expr.arguments[1], false);
    return direct;
  }
  if (ts.isArrowFunction(valueNode) || ts.isFunctionExpression(valueNode)) {
    parseInspectOptions(L, expr.arguments[1], false);
    return str(valueNode.kind === ts.SyntaxKind.FunctionExpression && (valueNode as ts.FunctionExpression).name ? `[Function: ${(valueNode as ts.FunctionExpression).name!.text}]` : "[Function (anonymous)]", loc);
  }
  const value = L.lowerExpr(valueNode);
  if (value.type.kind === "bytes") {
    // One runtime representation serves Buffer AND Uint8Array; their
    // renderings differ (<Buffer aa> vs Uint8Array(1) [ 170 ]), so the
    // TOP-LEVEL argument's checker type picks — and only Buffer lowers.
    // Nested bytes fence in inspectSupport (no checker type survives
    // into shapes).
    const tname = L.checker.typeToString(L.checker.getBaseTypeOfLiteralType(L.typeOf(valueNode)));
    const isBuffer = tname === "Buffer" || tname === "NonSharedBuffer" || tname.startsWith("Buffer<") || tname.startsWith("NonSharedBuffer<");
    if (value.type.elem !== "u8" || !isBuffer) {
      L.noLowering(
        `util.inspect of '${tname}' values`,
        valueNode,
        "Buffer's <Buffer ..> form is the lowered typed-array rendering; other typed arrays fence",
      );
    }
    const bufDepth = parseInspectOptions(L, expr.arguments[1], false);
    void bufDepth; // Buffers render fully at any depth (custom inspect)
    return inspectExpr(L, value.type, value, num(0, loc), num(2, loc), loc);
  }
  const walk = { recursive: false };
  const reason = inspectSupport(L, value.type, new Set(), walk);
  if (reason !== null) {
    L.noLowering(`util.inspect of '${L.fmt(value.type)}' values`, valueNode, reason);
  }
  const depth = parseInspectOptions(L, expr.arguments[1], walk.recursive);
  return inspectExpr(L, value.type, value, num(0, loc), num(depth, loc), loc);
}

/* ── util.format / util.formatWithOptions ────────────────────────────── */

/** One argument as format's %s conversion (Node: numbers via
 * formatNumber, strings verbatim, objects through inspect at the given
 * depth). Null = fence with the given reason. */
function formatSArg(L: Lowerer, node: ts.Expression, depth: number, loc: SrcLoc): IrExpr {
  const value = L.lowerExpr(node);
  const t = value.type;
  if (t.kind === "string") return value;
  if (t.kind === "f64") return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
  if (t.kind === "bool") return { kind: "toString", operand: value, type: STRING, loc };
  if (t.kind === "undefinedT") return str("undefined", loc);
  if (t.kind === "nullT") return str("null", loc);
  // %s of a symbol prints inspect's text ("Symbol(foo)") — String(sym)'s
  // answer too, one runtime call either way.
  if (t.kind === "symbol") return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc };
  if (t.kind === "dyn") {
    return { kind: "libCall", fn: "insp.dynS", args: [value, num(depth, loc)], type: STRING, loc };
  }
  // A UNION argument dispatches per arm at runtime: a string arm prints
  // VERBATIM (typeof arg === 'string' in Node's formatter — inspect's
  // quoting never applies at the top level), every other arm inspects.
  if (t.kind === "union") {
    const walk = { recursive: false };
    const reason = inspectSupport(L, t, new Set(), walk);
    if (reason !== null) L.noLowering(`util.format %s of '${L.fmt(t)}' values`, node, reason);
    return formatValueExpr(L, t, value, depth, loc);
  }
  if (t.kind === "object" && !isErrorClass(L, t.className)) {
    // hasBuiltInToString: a class with its OWN toString goes through
    // String(arg) in Node, not inspect — call it explicitly instead.
    for (let info: ClassInfo | null = L.classes.get(t.className) ?? null; info; info = info.base) {
      if (info.methods.has("toString")) {
        L.noLowering(
          "util.format %s over a class with its own toString",
          node,
          "Node calls the override (String(arg)) — call it explicitly",
        );
      }
    }
  }
  if (t.kind === "bytes") {
    L.noLowering(`util.format %s of typed-array values`, node, "pass util.inspect(buf) explicitly");
  }
  const walk = { recursive: false };
  const reason = inspectSupport(L, t, new Set(), walk);
  if (reason !== null) L.noLowering(`util.format %s of '${L.fmt(t)}' values`, node, reason);
  return inspectExpr(L, t, value, num(0, loc), num(depth, loc), loc);
}

/** %O (depth 2) / %o (showHidden, depth 4) — inspect with the spec's
 * option deltas; %o fences over arrays (showHidden adds their hidden
 * [length] entry, which has no lowering). */
function formatOArg(L: Lowerer, node: ts.Expression, depth: number, loc: SrcLoc): IrExpr {
  const value = L.lowerExpr(node);
  if (value.type.kind === "bytes") {
    L.noLowering(`util.format %${depth === 4 ? "o" : "O"} of typed-array values`, node, "pass util.inspect(buf) explicitly");
  }
  const walk = { recursive: false };
  const reason = inspectSupport(L, value.type, new Set(), walk);
  if (reason !== null) L.noLowering(`util.format %${depth === 4 ? "o" : "O"} of '${L.fmt(value.type)}' values`, node, reason);
  if (depth === 4 && typeTreeHasArray(L, value.type, new Set())) {
    L.noLowering(
      "util.format %o over arrays",
      node,
      "%o renders with showHidden (arrays gain a hidden [length] entry) — use %O for the default rendering",
    );
  }
  return inspectExpr(L, value.type, value, num(0, loc), num(depth, loc), loc);
}

/** util.format(...) / util.formatWithOptions({}, ...): the compile-time
 * %-substitution over a literal format string (formatWithOptionsInternal
 * ported exactly — the arg cursor, the args-exhausted guard, %c's
 * consume-and-drop), with per-static-type conversions. Non-literal
 * format strings lower only in the substitution-free shapes. */
export function lowerFormatCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc, withOptions: boolean): IrExpr {
  const argNodes = [...expr.arguments];
  if (withOptions) {
    const opts = argNodes.shift();
    if (!opts || !ts.isObjectLiteralExpression(opts) || opts.properties.length > 0) {
      L.noLowering(
        "util.formatWithOptions with a non-empty options literal",
        opts ?? expr,
        "only the empty literal {} (the defaults — exactly util.format) is lowered",
      );
    }
  }
  if (argNodes.length === 0) return str("", loc);
  const first = argNodes[0]!;
  const firstIsLiteral = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first);

  /** The rest-args tail: ` ` + (strings verbatim, everything else
   * inspected at the default depth). */
  const restArg = (node: ts.Expression): IrExpr => formatSArg(L, node, 2, loc);

  if (!firstIsLiteral) {
    const firstT = L.mapTypeOf(L.typeOf(first));
    if (firstT?.kind === "string" && argNodes.length > 1) {
      L.noLowering(
        "util.format with a runtime format string and further arguments",
        first,
        "the %-substitution positions are runtime-dependent — use a string literal",
      );
    }
    // No substitutions possible: every argument joins with spaces.
    const parts: IrExpr[] = [];
    for (let i = 0; i < argNodes.length; i++) {
      if (i > 0) parts.push(str(" ", loc));
      parts.push(restArg(argNodes[i]!));
    }
    return concatAll(parts, loc);
  }

  const fmt = (first as ts.StringLiteralLike).text;
  // Node's early return: a lone string first argument passes VERBATIM —
  // no substitution runs, "%%" stays "%%".
  if (argNodes.length === 1) return str(fmt, loc);
  const parts: IrExpr[] = [];
  let a = 0; // the arg cursor over argNodes (0 = the format string)
  let lastPos = 0;
  const args = argNodes;
  const convert = (spec: number, node: ts.Expression): IrExpr => {
    switch (spec) {
      case 115: // %s
        return formatSArg(L, node, 0, loc);
      case 100: {
        // %d — Number(arg) formatted: numbers as-is, booleans 1/0,
        // strings through the runtime's ECMA-exact StringToNumber
        // (num.fromString — the same lowering Number(aString) takes).
        const value = L.lowerExpr(node);
        if (value.type.kind === "f64") return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
        if (value.type.kind === "string") {
          const parsed: IrExpr = { kind: "libCall", fn: "num.fromString", args: [value], type: F64, loc };
          return { kind: "libCall", fn: "insp.f64", args: [parsed], type: STRING, loc };
        }
        if (value.type.kind === "bool") {
          return {
            kind: "libCall",
            fn: "insp.f64",
            args: [{ kind: "ternary", cond: value, then: num(1, loc), else_: num(0, loc), type: F64, loc }],
            type: STRING,
            loc,
          };
        }
        // A checked-dynamic argument (`console.log('... actual %d.',
        // context.actual)` — test/common's exit report): VALIDATE it as a
        // number (dynCheck) and format. A non-number dyn value throws the
        // catchable TypeError where Node would print its ToNumber (NaN
        // for objects) — loud, never a silent wrong answer (SEMANTICS.md).
        if (value.type.kind === "dyn") {
          return {
            kind: "libCall",
            fn: "insp.f64",
            args: [{ kind: "dynCheck", value, type: F64, loc }],
            type: STRING,
            loc,
          };
        }
        L.noLowering(`util.format %d of '${L.fmt(value.type)}' values`, node, "numbers, booleans, and strings lower; ToNumber over other types has no static lowering");
        break;
      }
      case 105: {
        // %i — parseInt(ToString(arg)): the spec-exact composition.
        const value = L.lowerExpr(node);
        if (value.type.kind === "f64" || value.type.kind === "bool" || value.type.kind === "string") {
          const text: IrExpr = value.type.kind === "string" ? value : { kind: "toString", operand: value, type: STRING, loc };
          const parsed: IrExpr = { kind: "libCall", fn: "num.parseInt", args: [text, num(0, loc)], type: F64, loc };
          return { kind: "libCall", fn: "insp.f64", args: [parsed], type: STRING, loc };
        }
        L.noLowering(`util.format %i of '${L.fmt(value.type)}' values`, node);
        break;
      }
      case 106: {
        // %j — JSON.stringify; undefined-valued args print "undefined"
        // (Node appends the non-string result of tryStringify).
        const value = L.lowerExpr(node);
        if (value.type.kind === "undefinedT") return str("undefined", loc);
        // JSON.stringify(sym) is undefined in Node — %j prints the
        // "undefined" text. Folding drops the operand, so only
        // side-effect-free reads compose (the typeof-fold stance).
        if (value.type.kind === "symbol") {
          if (!pureReemittable(value)) {
            L.noLowering(
              `util.format %j of computed symbol values`,
              node,
              "bind the symbol to a const first (the %j text is always \"undefined\")",
            );
          }
          return str("undefined", loc);
        }
        // A checked-dynamic argument (`console.error('headers: %j',
        // headers)` — the suite's http logging idiom): the runtime dyn
        // walk stringifies JS-exactly (root undefined/function prints
        // "undefined"; a handle in the tree throws the loud fence).
        if (value.type.kind === "dyn") {
          return { kind: "libCall", fn: "insp.jsonDyn", args: [value], type: STRING, loc };
        }
        if (!L.jsonSafe(value.type)) {
          L.noLowering(`util.format %j of '${L.fmt(value.type)}' values`, node, "only JSON-safe static types lower");
        }
        return { kind: "jsonStringify", value, type: STRING, loc };
      }
      case 79: // %O — inspect at the defaults
        return formatOArg(L, node, 2, loc);
      case 111: // %o — showHidden semantics; depth 4
        return formatOArg(L, node, 4, loc);
    }
    throw new Error("unreachable format spec");
  };

  for (let i = 0; i < fmt.length - 1; i++) {
    if (fmt.charCodeAt(i) === 37 /* % */) {
      const nextChar = fmt.charCodeAt(++i);
      if (a + 1 !== args.length) {
        switch (nextChar) {
          case 115: // s
          case 106: // j
          case 100: // d
          case 79: // O
          case 111: // o
          case 105: { // i
            const node = args[++a]!;
            if (lastPos !== i - 1) parts.push(str(fmt.slice(lastPos, i - 1), loc));
            parts.push(convert(nextChar, node));
            lastPos = i + 1;
            continue;
          }
          case 102: // f — parseFloat's full grammar has no static lowering
            L.noLowering("util.format %f", expr, "parseFloat has no static lowering (it runs with --dynamic)");
            break;
          case 99: // c — consumes its argument, contributes nothing
            a += 1;
            if (lastPos !== i - 1) parts.push(str(fmt.slice(lastPos, i - 1), loc));
            lastPos = i + 1;
            continue;
          case 37: // %%
            parts.push(str(fmt.slice(lastPos, i), loc));
            lastPos = i + 1;
            continue;
          default:
            continue;
        }
      } else if (nextChar === 37) {
        parts.push(str(fmt.slice(lastPos, i), loc));
        lastPos = i + 1;
      }
    }
  }
  if (lastPos !== 0) {
    a++;
    if (lastPos < fmt.length) parts.push(str(fmt.slice(lastPos), loc));
  } else {
    // No substitution touched the format string: it joins verbatim, and
    // the cursor advances past it.
    parts.push(str(fmt, loc));
    a++;
  }
  for (; a < args.length; a++) {
    parts.push(str(" ", loc));
    parts.push(restArg(args[a]!));
  }
  return concatAll(parts, loc);
}

/** Arrays anywhere in the tree — the %o (showHidden) gate. */
function typeTreeHasArray(L: Lowerer, t: IrType, visiting: Set<string>): boolean {
  switch (t.kind) {
    case "array":
      return true;
    case "record": {
      if (visiting.has(t.shapeId)) return false;
      visiting.add(t.shapeId);
      const shape = L.shapes.get(t.shapeId);
      if (shape?.tuple) return true;
      return (shape?.fields ?? []).some((f) => typeTreeHasArray(L, f.type, visiting));
    }
    case "map":
      return typeTreeHasArray(L, t.key, visiting) || typeTreeHasArray(L, t.value, visiting);
    case "set":
      return typeTreeHasArray(L, t.elem, visiting);
    case "union": {
      if (visiting.has(t.unionId)) return false;
      visiting.add(t.unionId);
      return (L.unions.get(t.unionId)?.arms ?? []).some((a) => typeTreeHasArray(L, a, visiting));
    }
    case "object": {
      if (visiting.has(t.className)) return false;
      visiting.add(t.className);
      return (L.classes.get(t.className)?.def.fields ?? []).some((f) => typeTreeHasArray(L, f.type, visiting));
    }
    case "bytes":
      return true;
    default:
      return false;
  }
}

/* ── the module dispatch ─────────────────────────────────────────────── */

/** The spoke's entry, called from both the named-import and namespace/
 * default-import call paths. Null for other modules and members (the
 * module tables' fence takes over). */
export function lowerUtilModuleCall(
  L: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "util") return null;
  switch (bi.member) {
    case "inspect":
      return lowerInspectCall(L, expr, loc);
    case "format":
      return lowerFormatCall(L, expr, loc, false);
    case "formatWithOptions":
      return lowerFormatCall(L, expr, loc, true);
    case "parseArgs":
      return lowerParseArgsCall(L, expr, loc);
    case "getCallSites":
      return lowerGetCallSitesCall(L, expr, loc);
    default:
      return null;
  }
}

/** util.parseArgs(config?): the configuration is ordinary JSON-safe data,
 * so it crosses into the runtime as a checked-dynamic tree. The native
 * parser returns the same tree-shaped result Node does (including token
 * variants and a null-prototype values object); statically typed member
 * reads leave that tree through the ordinary dyn checks. */
function lowerParseArgsCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.length > 1 || expr.arguments.some(ts.isSpreadElement)) {
    L.noLowering(
      `util.parseArgs with ${expr.arguments.length} arguments`,
      expr,
      "the lowered form is parseArgs() or parseArgs(config)",
    );
  }

  let config: IrExpr;
  const configNode = expr.arguments[0];
  if (!configNode) {
    config = { kind: "dynObjLit", fields: [], type: DYN, loc };
  } else {
    const raw = L.lowerExpr(configNode);
    if (raw.type.kind === "dyn") {
      config = raw;
    } else if (raw.type.kind === "jsval") {
      config = { kind: "dynFromJsval", value: raw, type: DYN, loc };
    } else if (canConvertToDyn(raw.type, (id) => L.shapes.get(id), (id) => L.unions.get(id))) {
      // parseArgs assigns descriptor default arrays directly into the
      // returned values object. Keep mutable config composites in typed-ref
      // capsules so that default arrays can leave the dyn result as the
      // original static reference; the runtime still snapshots `args` and
      // the option schema before parsing, matching Node's synchronous read.
      const liveRef = raw.type.kind === "record" || raw.type.kind === "array" ||
        raw.type.kind === "bytes";
      config = {
        kind: "dynFrom",
        value: raw,
        ...(liveRef ? { liveRef: true as const } : {}),
        type: DYN,
        loc,
      };
    } else {
      L.noLowering(
        `util.parseArgs with a '${L.fmt(raw.type)}' configuration`,
        configNode,
        "pass the documented JSON-safe config object (args/options and boolean flags)",
      );
    }
  }

  const parsed: IrExpr = {
    kind: "libCall",
    fn: "util.parseArgs",
    args: [config],
    type: DYN,
    loc,
  };
  const result = L.mapTypeOf(L.typeOf(expr));
  if (
    result !== null && result.kind !== "dyn" && result.kind !== "jsval" && result.kind !== "void" &&
    canDynCheckTo(result, (id) => L.shapes.get(id), (id) => L.unions.get(id))
  ) {
    return { kind: "dynCheck", value: parsed, type: result, loc };
  }
  return parsed;
}

/** util.getCallSites() in a JS source: compiled binaries keep no runtime
 * call stacks, so the honest STATIC answer is a fixed-shape placeholder —
 * a fresh dyn array of three call-site records whose scriptName is the
 * CALL SITE's own file (compile-time-knowable) and whose line/column are
 * 0 (SEMANTICS.md; the fields exist so consumers like test/common's
 * mustNotCall — `callSite.scriptName`:`callSite.lineNumber` in the
 * failure text — read a printable value instead of throwing). Argument
 * forms and TypeScript keep the SC2020 fence: a typed consumer asserting
 * real frames must fail loudly at compile time, not read placeholders. */
function lowerGetCallSitesCall(L: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr | null {
  if (expr.arguments.length !== 0) return null;
  if (!isJsSourceFile(expr.getSourceFile())) return null;
  const frame = (): IrExpr => {
    const field = (name: string, value: IrExpr): { key: IrExpr; value: IrExpr } => ({
      key: { kind: "strLit", value: name, type: STRING, loc },
      value: { kind: "dynFrom", value, type: DYN, loc },
    });
    return {
      kind: "dynObjLit",
      fields: [
        field("functionName", { kind: "strLit", value: "", type: STRING, loc }),
        field("scriptName", { kind: "strLit", value: expr.getSourceFile().fileName, type: STRING, loc }),
        field("scriptId", { kind: "strLit", value: "0", type: STRING, loc }),
        field("lineNumber", { kind: "numLit", value: 0, type: F64, loc }),
        field("column", { kind: "numLit", value: 0, type: F64, loc }),
      ],
      type: DYN,
      loc,
    };
  };
  return { kind: "dynArrLit", elems: [frame(), frame(), frame()], type: DYN, loc };
}
