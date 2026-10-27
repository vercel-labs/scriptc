import { keyedHelperName } from "./stable-names.js";
import { perKeyOrder } from "./key-order-witness.js";
import { elementMayBeForeign } from "./array-values.js";
import { classPrototypeView } from "./class-prototypes.js";
import {
  dynUndefinedExpr,
  boolLit,
  helperLoc,
  nodeThrowExpr,
  numLit,
  strLit,
  varRef,
} from "../../ir/build.js";
import { builtinClassDynValueOf, builtinClassKindOf } from "./builtins/builtin-class-dyn.js";
import { InternalCompilerError } from "../../errors.js";

import * as ts from "../ts7/adapter.js";
import { unsignedHex } from "../../format-integer.js";
import { jsFuncNameOf, type Lowerer } from "./lowerer.js";
import { isJsSourceFile, locOf } from "../program.js";
import { noLoweringDiag } from "../../diagnostics/diagnostic.js";
import {
  BOOL,
  CAUGHT,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
  type IrStrIntrinsicMethod,
  type IrType,
  RUNTIME_ERROR_CLASSES,
  STRING,
  isUnitType,
  UNDEFINED_T,
  VOID,
  type SrcLoc,
  canConvertToDyn,
  canDynCheckTo,
  funcOf,
  arrayOf,
  CLASS_FIELD_ATTRIBUTES_PREFIX,
  classDynViewSupported,
  DYN_CLASS_PROPERTIES,
  isClassOwnEnumerableFieldName,
  isDirentShape,
  isDynTypedRefType,
  recordTextCodecClass,
  shapeHasAccessorSlots,
  shapeKeyOrders,
  typeKey,
} from "../../ir/ir.js";
import { accessorCall, findMethodOn, type ClassInfo } from "./lower-classes.js";
import { isSafeToDiscard, isSafeToRepeat } from "./expressions/evaluation-safety.js";
import {
  INSPECT_CUSTOM_MEMBER,
  symbolFieldDisplayName,
  TO_STRING_TAG_FIELD,
} from "./symbol-fields.js";
import { eventTargetRootOf } from "./lower-event-target.js";
import { dateRootOf } from "./builtins/date-classes.js";
import { lowerSystemErrorMap } from "./lower-system-errors.js";
import { isPerfEntryType, perfEntryJson } from "./builtins/performance.js";
import { recordMayKeepSource, recordSourceTest } from "./record-sources.js";
import { nullProtoRecordShape, recordNullProtoTest } from "./null-prototype.js";
import { dynArgumentPack } from "./call-arguments.js";

/* ── IR construction shorthand ───────────────────────────────────────── */
function concatAll(parts: IrExpr[], loc: SrcLoc): IrExpr {
  if (parts.length === 0) return strLit("", loc);
  let out = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    out = { kind: "strConcat", left: out, right: parts[i]!, type: STRING, loc };
  }
  return out;
}

/* ── property-name rendering (compile-time keys) ─────────────────────── */

/** strEscape's quote ladder over a COMPILE-TIME string (record field
 * names, format-string chunks never pass through here — only keys).
 * Mirrors scr_inspect.c's insp_quote_into exactly. */
function inspectQuote(s: string): string {
  const hasSingle = s.includes("'");
  const quote = !hasSingle
    ? "'"
    : !s.includes('"')
      ? '"'
      : !s.includes("`") && !s.includes("${")
        ? "`"
        : "'";
  let body = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) {
      const meta = ["\\b", "\\t", "\\n", undefined, "\\f", "\\r"][c - 8];
      body +=
        c >= 8 && c <= 13 && meta !== undefined
          ? meta
          : `\\x${unsignedHex(c).toUpperCase().padStart(2, "0")}`;
    } else if (c === 0x27 && quote === "'") {
      body += "\\'";
    } else if (c === 0x5c) {
      body += "\\\\";
    } else if (c >= 0x7f && c <= 0x9f) {
      body += `\\x${unsignedHex(c).toUpperCase().padStart(2, "0")}`;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        body += s[i]! + s[i + 1]!;
        i++;
      } else {
        body += `\\u${unsignedHex(c)}`;
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
  // fields are own properties the runtime rendering would miss. A user
  // class's layout repeats its builtin base's prefix fields, which are
  // those same slots. #private fields are NOT own properties — Node never
  // prints them — so they don't disqualify.
  if (!info.builtinError) {
    const inherited = new Set<string>();
    for (let c = info.base; c; c = c.base) {
      if (c.builtinError || c.def.runtime) for (const f of c.def.fields) inherited.add(f.name);
    }
    if (info.def.fields.some((f) => !f.name.startsWith("#") && !inherited.has(f.name)))
      return false;
  }
  return info.subclasses.every((s) => errorRenderable(s));
}

/** The accessors that change what Node reads for an error's header. The
 * runtime renders the instance's own name and message slots. */
const ERROR_HEADER_ACCESSORS = [
  "get:name",
  "set:name",
  "get:message",
  "set:message",
  "get:stack",
  "set:stack",
];

/** Whether Node's header for an instance of `info`'s hierarchy can differ
 * from the runtime's slots: a program class among its ancestors or
 * descendants declares a `name`, `message` or `stack` accessor, or the
 * program writes a prototype's `name` or `message`. */
function errorHeaderOverridden(lowerer: Lowerer, info: ClassInfo): boolean {
  if (lowerer.prototypeMethodAccesses.has("name") || lowerer.prototypeMethodAccesses.has("message"))
    return true;
  const declares = (c: ClassInfo): boolean =>
    !c.builtinError && !c.def.runtime && ERROR_HEADER_ACCESSORS.some((m) => c.methods.has(m));
  for (let c = info.base; c; c = c.base) if (declares(c)) return true;
  const below = (c: ClassInfo): boolean => declares(c) || c.subclasses.some(below);
  return below(info);
}

/** Error keys Node's error inspector folds into the base or hides. */
const ERROR_SPECIAL_KEYS = new Set(["name", "message", "stack", "cause", "errors"]);

/** The declared own (enumerable) fields of a user error class, in layout
 * order (the base chain first). */
function ownErrorFields(info: ClassInfo): { name: string; type: IrType }[] {
  // The builtin bases' layout fields (name, message) are runtime slots the
  // error base already renders, not own enumerable properties.
  const builtin = new Set<string>();
  for (let c = info.base; c; c = c.base) {
    if (c.builtinError || c.def.runtime) for (const f of c.def.fields) builtin.add(f.name);
  }
  return info.def.fields.filter(
    (f) => isClassOwnEnumerableFieldName(f.name) && !builtin.has(f.name),
  );
}

/** `info` and its descendants that declare fields, most-derived first (a
 * runtime instance tests against its own class before an ancestor's). */
function fieldedErrorClasses(info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  const visit = (c: ClassInfo): void => {
    for (const s of c.subclasses) visit(s);
    if (!c.builtinError && !c.def.runtime && ownErrorFields(c).length > 0) out.push(c);
  };
  visit(info);
  return out;
}

/** Why a fielded error class's own properties have no static rendering,
 * or null when every field renders. `visiting` and `out` are the caller's
 * inspectSupport walk: a field typed as the class itself (`next?: Chain`)
 * is a recursive shape, not a new walk. */
function fieldedErrorReason(
  lowerer: Lowerer,
  info: ClassInfo,
  visiting: Set<string> = new Set(),
  out: { recursive: boolean } = { recursive: false },
): string | null {
  const key = `error:${info.def.name}`;
  if (visiting.has(key)) {
    out.recursive = true;
    return null;
  }
  visiting.add(key);
  try {
    for (let c: ClassInfo | null = info; c && !c.builtinError && !c.def.runtime; c = c.base) {
      // Node prints the own properties in creation order, which puts a
      // declared `cause` among the fields; the cause renders after them.
      if (c.fieldOrder.some((f) => f.errorCause))
        return "its field 'cause' is one Node's error inspector treats specially";
      // A JavaScript class's fields exist once its constructor creates them,
      // which can be conditional; the layout reads every field.
      if (c.decl && isJsSourceFile(c.decl.getSourceFile()) && ownErrorFields(c).length > 0)
        return "its fields are JavaScript properties, which its constructor may not create";
    }
    for (const f of ownErrorFields(info)) {
      if (ERROR_SPECIAL_KEYS.has(f.name))
        return `its field '${f.name}' is one Node's error inspector treats specially`;
      const why = inspectSupport(lowerer, f.type, visiting, out);
      if (why !== null) return `its field '${f.name}': ${why}`;
    }
    return null;
  } finally {
    visiting.delete(key);
  }
}

/** True when an instance of `c` can contain itself: its fields reach `c`
 * or one of its bases, whose slots can hold a `c` (`next: Chain` in a
 * subclass of Chain, a field typed as Error). */
function errorInstanceReachesItself(lowerer: Lowerer, c: ClassInfo): boolean {
  const holders = new Set<string>();
  for (let a: ClassInfo | null = c; a; a = a.base) holders.add(a.def.name);
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    for (const x of typeConstituents(lowerer, u)) {
      if (x.kind === "object" && holders.has(x.className)) return true;
      const k = typeKey(x);
      if (!seen.has(k)) {
        seen.add(k);
        if (walk(x)) return true;
      }
    }
    return false;
  };
  return walk({ kind: "object", className: c.def.name });
}

/** An error value whose runtime class may be a program-declared subclass,
 * which may declare fields (`class Bailable extends Error { bail = false }`)
 * or carry a `cause`: Node prints the error base (`[Bailable [Error]: m]`,
 * the stackless form compiled errors use) followed by the own properties,
 * `[Bailable [Error]: m] { bail: true }`, with the usual single-line/
 * multi-line choice counting the base. Each program class (most-derived
 * first) is an instanceof arm; other values keep the runtime's error
 * rendering. Beyond the depth budget an instance with own properties
 * prints `[Name]`, as Node does for any object with keys; one without
 * prints its header. */
function errorInspectHelper(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
  info: ClassInfo,
  loc: SrcLoc,
): string {
  const key = `insp.userError:${typeKey(t)}`;
  const existing = lowerer.inspectHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%util.insp", key);
  lowerer.inspectHelpers.set(key, name);
  const v = (): IrExpr => varRef("v.0", t, loc);
  const r = (): IrExpr => varRef("r.0", F64, loc);
  const d = (): IrExpr => varRef("d.0", F64, loc);
  const rPlus1 = (): IrExpr => ({
    kind: "bin",
    op: "+",
    left: r(),
    right: numLit(1, loc),
    type: F64,
    loc,
  });
  const base = (): IrExpr => ({
    kind: "libCall",
    fn: "insp.error",
    args: [v(), r(), d()],
    type: STRING,
    loc,
  });
  const error = (): IrExpr => lowerer.upcastTo(v(), "%Error");
  const hasCause = (): IrExpr => ({
    kind: "libCall",
    fn: "insp.errorHasCause",
    args: [error()],
    type: BOOL,
    loc,
  });
  const entry = (text: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "insp.entry",
      args: [text, boolLit(false, loc)],
      type: VOID,
      loc,
    },
    loc,
  });
  /** The own properties of an instance of `c`: its fields, then its
   * `cause` (an assignment in the constructor or later, or the
   * constructor's options, which Node lists last as `[cause]`). */
  const propertiesArm = (
    c: ClassInfo,
    display: string,
    fields: { name: string; type: IrType }[],
  ): IrStmt[] => {
    const cls: IrType & { kind: "object" } = { kind: "object", className: c.def.name };
    const instance: IrExpr =
      c.def.name === t.className ? v() : { kind: "downcast", value: v(), type: cls, loc };
    // A class whose fields can hold the instance itself (`next: Chain`)
    // runs Node's circular machinery, as other cycle-capable objects do:
    // an instance already on the traversal stack renders [Circular *N],
    // before the depth answer, and the frame's text gets the <ref *N>
    // prefix when the walk found it circular.
    const onCycle = errorInstanceReachesItself(lowerer, c);
    const circular = (): IrExpr => varRef("cc.0", F64, loc);
    const arm: IrStmt[] = [
      ...(onCycle
        ? ([
            {
              kind: "varDecl",
              localId: "cc.0",
              init: { kind: "libCall", fn: "insp.circCheck", args: [v()], type: F64, loc },
              loc,
            },
            {
              kind: "if",
              cond: {
                kind: "bin",
                op: ">",
                left: circular(),
                right: numLit(0, loc),
                type: BOOL,
                loc,
              },
              then: [
                {
                  kind: "return",
                  value: {
                    kind: "libCall",
                    fn: "insp.circular",
                    args: [circular()],
                    type: STRING,
                    loc,
                  },
                  loc,
                },
              ],
              else_: null,
              loc,
            },
          ] satisfies IrStmt[])
        : []),
      {
        kind: "if",
        cond: { kind: "bin", op: ">", left: r(), right: d(), type: BOOL, loc },
        then: [{ kind: "return", value: strLit(`[${display}]`, loc), loc }],
        else_: null,
        loc,
      },
      {
        kind: "varDecl",
        localId: "base.0",
        init: improvedErrorBase(lowerer, v(), base(), display, loc),
        loc,
      },
      {
        kind: "exprStmt",
        expr: { kind: "libCall", fn: "insp.begin", args: [rPlus1()], type: VOID, loc },
        loc,
      },
      ...(onCycle
        ? ([
            {
              kind: "exprStmt",
              expr: { kind: "libCall", fn: "insp.seenPush", args: [v()], type: VOID, loc },
              loc,
            },
          ] satisfies IrStmt[])
        : []),
    ];
    for (const f of fields) {
      const read: IrExpr = {
        kind: "fieldGet",
        obj: instance,
        className: c.def.name,
        field: f.name,
        type: f.type,
        loc,
      };
      arm.push(
        entry(
          concatAll(
            [
              strLit(`${inspectKey(f.name)}: `, loc),
              inspectExpr(lowerer, f.type, read, rPlus1(), d(), loc),
            ],
            loc,
          ),
        ),
      );
    }
    arm.push({
      kind: "if",
      cond: hasCause(),
      then: [
        entry({
          kind: "libCall",
          fn: "insp.errorCause",
          args: [error(), rPlus1(), d()],
          type: STRING,
          loc,
        }),
      ],
      else_: null,
      loc,
    });
    const ended: IrExpr = {
      kind: "libCall",
      fn: "insp.end",
      args: [
        varRef("base.0", STRING, loc),
        strLit("{", loc),
        strLit("}", loc),
        rPlus1(),
        boolLit(false, loc),
        boolLit(false, loc),
      ],
      type: STRING,
      loc,
    };
    arm.push({
      kind: "return",
      value: onCycle
        ? { kind: "libCall", fn: "insp.refWrap", args: [v(), ended], type: STRING, loc }
        : ended,
      loc,
    });
    return arm;
  };
  const body: IrStmt[] = [];
  for (const c of userErrorClasses(info)) {
    const display = c.def.jsName ?? c.decl?.name?.text ?? c.def.name.replace(/^%/, "");
    const fields = ownErrorFields(c);
    const why = fields.length > 0 ? fieldedErrorReason(lowerer, c) : null;
    let arm: IrStmt[];
    if (why !== null) {
      // An instance of a subclass whose own properties have no rendering
      // throws a named refusal instead of printing a partial object.
      arm = [
        {
          kind: "return",
          value: nodeThrowExpr(
            0,
            "SC2020",
            `inspecting a '${display}' error (${why}) is not supported yet`,
            STRING,
            loc,
          ),
          loc,
        },
      ];
    } else if (fields.length === 0) {
      // A field-less program class: without a `cause` it has no own
      // properties, and Node prints the header alone at any depth.
      arm = [
        {
          kind: "if",
          cond: { kind: "unary", op: "!", operand: hasCause(), type: BOOL, loc },
          then: [
            { kind: "return", value: improvedErrorBase(lowerer, v(), base(), display, loc), loc },
          ],
          else_: null,
          loc,
        },
        ...propertiesArm(c, display, fields),
      ];
    } else {
      arm = propertiesArm(c, display, fields);
    }
    if (c.def.name === t.className) {
      body.push({ kind: "block", body: arm, loc });
      break;
    }
    body.push({
      kind: "if",
      cond: { kind: "instanceOf", value: v(), className: c.def.name, type: BOOL, loc },
      then: arm,
      else_: null,
      loc,
    });
  }
  if (body.at(-1)?.kind !== "block") body.push({ kind: "return", value: base(), loc });
  const fn: IrFunction = {
    name,
    params: [
      { localId: "v.0", name: "v", type: t },
      { localId: "r.0", name: "r", type: F64 },
      { localId: "d.0", name: "d", type: F64 },
    ],
    returnType: STRING,
    locals: [
      { id: "v.0", name: "v", type: t, mutable: false },
      { id: "r.0", name: "r", type: F64, mutable: false },
      { id: "d.0", name: "d", type: F64, mutable: false },
      { id: "base.0", name: "base", type: STRING, mutable: false },
      { id: "cc.0", name: "cc", type: F64, mutable: false },
      { id: "name.0", name: "name", type: STRING, mutable: true },
      { id: "raw.0", name: "raw", type: STRING, mutable: true },
    ],
    body,
    loc,
  };
  // Dynamic stores (a JavaScript class's `this.x = ...` outside its
  // declared fields, or a write through an untyped reference) add a
  // property bag to a class after this helper was built. The rendering
  // reads only a `cause` from it, so an instance whose bag holds another
  // property throws a named refusal instead of printing a partial object.
  lowerer.shapeOrderHelperFinalizers.push(() => {
    const bagged = [info, ...userErrorClasses(info)].filter(
      (c) =>
        !c.builtinError &&
        !c.def.runtime &&
        c.def.fields.some((f) => f.name === DYN_CLASS_PROPERTIES),
    );
    if (bagged.length === 0) return;
    fn.body = [
      ...bagged.map((c): IrStmt => ({
        kind: "if",
        cond: {
          kind: "logical",
          op: "&&",
          left: { kind: "instanceOf", value: v(), className: c.def.name, type: BOOL, loc },
          right: {
            kind: "libCall",
            fn: "insp.errorBagHasProperties",
            args: [
              {
                kind: "fieldGet",
                obj:
                  c.def.name === t.className
                    ? v()
                    : {
                        kind: "downcast",
                        value: v(),
                        type: { kind: "object", className: c.def.name },
                        loc,
                      },
                className: c.def.name,
                field: DYN_CLASS_PROPERTIES,
                type: DYN,
                loc,
              },
            ],
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "return",
            value: nodeThrowExpr(
              0,
              "SC2020",
              `inspecting a '${c.def.jsName ?? c.def.name.replace(/^%/, "")}' error with properties created at run time is not supported yet`,
              STRING,
              loc,
            ),
            loc,
          },
        ],
        else_: null,
        loc,
      })),
      ...body,
    ];
  });
  lowerer.liftedFns.push(fn);
  return name;
}

/** The program-declared classes among `info` and its descendants, most
 * derived first (an instance tests against its own class before an
 * ancestor's). Runtime-provided error classes are not among them. */
function userErrorClasses(info: ClassInfo): ClassInfo[] {
  const out: ClassInfo[] = [];
  const visit = (c: ClassInfo): void => {
    for (const s of c.subclasses) visit(s);
    if (!c.builtinError && !c.def.runtime) out.push(c);
  };
  visit(info);
  return out;
}

/** Node's improveStack over the stackless base (`[Error: m]`): when the
 * instance's constructor name differs from its `name` and the name ends in
 * "Error", the header names both — `[Bailable [Error]: m]`, or
 * `[FetchError: m]` when the constructor name already contains it. */
function improvedErrorBase(
  lowerer: Lowerer,
  value: IrExpr,
  base: IrExpr,
  display: string,
  loc: SrcLoc,
): IrExpr {
  const str = (
    method: IrStrIntrinsicMethod,
    receiver: IrExpr,
    args: IrExpr[],
    type: IrType,
  ): IrExpr => ({
    kind: "strIntrinsic",
    method,
    receiver,
    args,
    type,
    loc,
  });
  const and = (left: IrExpr, right: IrExpr): IrExpr => ({
    kind: "logical",
    op: "&&",
    left,
    right,
    type: BOOL,
    loc,
  });
  const eq = (left: IrExpr, right: IrExpr, negated = false): IrExpr => ({
    kind: "strEq",
    negated,
    left,
    right,
    type: BOOL,
    loc,
  });
  const nameRef = (): IrExpr => varRef("name.0", STRING, loc);
  const baseRef = (): IrExpr => varRef("raw.0", STRING, loc);
  const after = (): IrExpr => ({
    kind: "bin",
    op: "+",
    left: str("length", nameRef(), [], F64),
    right: numLit(1, loc),
    type: F64,
    loc,
  });
  const next = (): IrExpr => str("charAt", baseRef(), [after()], STRING);
  const cond = and(
    and(
      eq(nameRef(), strLit(display, loc), true),
      str("endsWith", nameRef(), [strLit("Error", loc)], BOOL),
    ),
    and(str("startsWith", baseRef(), [concatAll([strLit("[", loc), nameRef()], loc)], BOOL), {
      kind: "logical",
      op: "||",
      left: eq(next(), strLit(":", loc)),
      right: eq(next(), strLit("]", loc)),
      type: BOOL,
      loc,
    }),
  );
  const rest = (): IrExpr => str("slice", baseRef(), [after()], STRING);
  const improved: IrExpr = {
    kind: "ternary",
    cond: str("includes", strLit(display, loc), [nameRef()], BOOL),
    then: concatAll([strLit(`[${display}`, loc), rest()], loc),
    else_: concatAll([strLit(`[${display} [`, loc), nameRef(), strLit("]", loc), rest()], loc),
    type: STRING,
    loc,
  };
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "varDecl",
        localId: "name.0",
        init: {
          kind: "fieldGet",
          obj: lowerer.upcastTo(value, "%Error"),
          className: "%Error",
          field: "name",
          type: STRING,
          loc,
        },
        loc,
      },
      { kind: "varDecl", localId: "raw.0", init: base, loc },
    ],
    result: { kind: "ternary", cond, then: improved, else_: baseRef(), type: STRING, loc },
    type: STRING,
    loc,
  };
}

function isErrorClass(lowerer: Lowerer, className: string): boolean {
  if (RUNTIME_ERROR_CLASSES.has(className)) return true;
  return lowerer.isSubclassOf(className, "%Error");
}

/** inspUnsupportedReason: the deepUnsupportedReason twin. Fences name the
 * FIRST unsupported constituent. `visiting` terminates recursive shapes
 * and records their existence (the depth-null gate). */
function inspectSupport(
  lowerer: Lowerer,
  t: IrType,
  visiting: Set<string>,
  out: { recursive: boolean },
): string | null {
  switch (t.kind) {
    case "f64":
    case "string":
    case "bool":
    case "undefinedT":
    case "nullT":
    case "regex":
    case "symbol":
    case "bigint":
    case "date":
    case "dyn":
      return null;
    case "array":
      return inspectSupport(lowerer, t.elem, visiting, out);
    case "bytes":
      return null;
    case "record": {
      if (visiting.has(t.shapeId)) {
        out.recursive = true;
        return null;
      }
      visiting.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      if (!shape) return "this record shape has no inspect lowering";
      const codec = recordTextCodecClass(shape);
      if (codec !== null) return `${codec} instances have no inspect lowering yet`;
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
        const why = inspectSupport(lowerer, shape.indexValue, visiting, out);
        if (why !== null) return why;
        visiting.delete(t.shapeId);
        return null;
      }
      for (const f of shape.fields) {
        const why = inspectSupport(lowerer, f.type, visiting, out);
        if (why !== null) return why;
      }
      visiting.delete(t.shapeId);
      return null;
    }
    case "map": {
      const keyWhy = inspectSupport(lowerer, t.key, visiting, out);
      if (keyWhy !== null) return keyWhy;
      return inspectSupport(lowerer, t.value, visiting, out);
    }
    case "set":
      return inspectSupport(lowerer, t.elem, visiting, out);
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      if (!def) return "this union has no inspect lowering";
      if (visiting.has(t.unionId)) {
        out.recursive = true;
        return null;
      }
      visiting.add(t.unionId);
      for (const arm of def.arms) {
        const why = inspectSupport(lowerer, arm, visiting, out);
        if (why !== null) return why;
      }
      visiting.delete(t.unionId);
      return null;
    }
    case "func":
      return "function values have no inspect lowering (no runtime name exists — Node prints '[Function: name]'; pass the function's declared identifier directly to util.inspect for the baked form)";
    case "object": {
      const info = lowerer.classes.get(t.className);
      if (!info) return `class '${t.className}' has no inspect lowering`;
      const custom = customInspectReason(lowerer, info);
      if (custom !== null) return custom;
      // EventTarget and Event subclasses render through Node's inspectors
      // for those classes (the runtime's capsule view), and so do classes
      // declared `extends Date`.
      if (eventTargetRootOf(info) !== null || dateRootOf(info) !== null) return null;
      if (isErrorClass(lowerer, t.className)) {
        if (userErrorClasses(info).length > 0 && errorHeaderOverridden(lowerer, info))
          return "error subclasses whose name, message or stack is an accessor or a prototype property have no inspect lowering yet";
        if (errorRenderable(info)) return null;
        // Subclasses with declared fields render the error base followed
        // by their own properties. The static class's own fields must
        // render; a subclass whose fields cannot is a runtime refusal on
        // its own instances only (see errorInspectHelper).
        const own = fieldedErrorClasses(info).find((c) => c === info);
        const ownWhy = own ? fieldedErrorReason(lowerer, own, visiting, out) : null;
        if (ownWhy !== null)
          return `'${t.className.replace(/^%(m\d+\.)?/, "")}' error values (${ownWhy})`;
        return null;
      }
      // A class with subclasses, or a JavaScript class, renders through its
      // checked-dynamic view, which names the instance's own class and holds
      // its own properties.
      if (classInspectsThroughView(lowerer, info)) {
        if (!isDynTypedRefType(t) || visiting.has(t.className)) return null;
        visiting.add(t.className);
        const hierarchy = (current: ClassInfo): ClassInfo[] => [
          current,
          ...current.subclasses.flatMap(hierarchy),
        ];
        for (const member of hierarchy(info))
          for (const f of member.def.fields) {
            if (f.name.startsWith("#") || f.name.startsWith("%")) continue;
            const why = inspectSupport(lowerer, f.type, visiting, out);
            if (why !== null) return why;
          }
        visiting.delete(t.className);
        return null;
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
        const why = inspectSupport(lowerer, f.type, visiting, out);
        if (why !== null) return why;
      }
      visiting.delete(t.className);
      return null;
    }
    // Generator objects print through their checked capsule: Node's
    // `Object [Generator] {}`, or the tag of the iterator they implement.
    // URLs and URLSearchParams print through their handles.
    case "generator":
    case "url":
    case "searchParams":
      return null;
    default:
      return `'${lowerer.fmt(t)}' values have no inspect lowering`;
  }
}

/* ── the per-type rendering expression ───────────────────────────────── */

/** True when a runtime value of `t` at index expr `v` answers
 * `typeof v === 'number'` — the grid-grouping order flag. */
function isNumberFlag(lowerer: Lowerer, t: IrType, v: () => IrExpr, loc: SrcLoc): IrExpr {
  if (t.kind === "f64") return boolLit(true, loc);
  if (t.kind === "union") {
    const def = lowerer.unions.get(t.unionId);
    const tag = def ? def.arms.findIndex((a) => a.kind === "f64") : -1;
    if (tag >= 0) {
      return {
        kind: "unionIsTag",
        unionId: t.unionId,
        tag,
        negated: false,
        value: v(),
        type: BOOL,
        loc,
      };
    }
  }
  return boolLit(false, loc);
}

/** The rendering of one value of type `t` at runtime depth `recurse`
 * with the depth budget `depth` — a direct scalar libCall or a call of
 * the interned per-type helper. */
export function inspectExpr(
  lowerer: Lowerer,
  t: IrType,
  value: IrExpr,
  recurse: IrExpr,
  depth: IrExpr,
  loc: SrcLoc,
  /** The instance's own rendering, without its custom inspect method. */
  ownRendering = false,
): IrExpr {
  const render = inspectExprBody(lowerer, t, value, recurse, depth, loc, ownRendering);
  // A top-level render through emitted helpers that can reach a refusal
  // (the 'not supported yet' Error of insp.dyn) unwinds the inspector to
  // its state before the render on every exit: the Error propagates out of
  // the helpers before they close their frames.
  if (
    render.kind !== "call" ||
    recurse.kind !== "numLit" ||
    recurse.value !== 0 ||
    !inspectMayRefuse(lowerer, t)
  )
    return render;
  return withInspectUnwind(lowerer, render, t, loc);
}

/** A top-level helper render (`call helper(v, r, d)`) through a lifted
 * wrapper that takes insp.mark first and runs insp.unwind however the
 * render ends: `try { return helper(v, r, d); } finally { insp.unwind(); }`.
 * A seqExpr cannot hold the try. */
function withInspectUnwind(
  lowerer: Lowerer,
  render: IrExpr & { kind: "call" },
  t: IrType,
  loc: SrcLoc,
): IrExpr {
  const key = `unwind:${render.callee}`;
  let name = lowerer.inspectHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%util.inspUnwound", key);
    lowerer.inspectHelpers.set(key, name);
    const params = [
      { localId: "v.0", name: "v", type: t },
      { localId: "r.0", name: "r", type: F64 },
      { localId: "d.0", name: "d", type: F64 },
    ];
    const call = (fn: "insp.mark" | "insp.unwind"): IrStmt => ({
      kind: "exprStmt",
      expr: { kind: "libCall", fn, args: [], type: VOID, loc },
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params,
      returnType: STRING,
      locals: params.map((p) => ({ id: p.localId, name: p.name, type: p.type, mutable: false })),
      body: [
        call("insp.mark"),
        {
          kind: "tryCatch",
          tryBody: [
            {
              kind: "return",
              value: {
                kind: "call",
                callee: render.callee,
                args: params.map((p) => varRef(p.localId, p.type, loc)),
                type: STRING,
                loc,
              },
              loc,
            },
          ],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [call("insp.unwind")],
          loc,
        },
      ],
      loc,
    });
  }
  return { ...render, callee: name };
}

/** Whether inspecting a `t` value can end in an inspection refusal: `t`
 * or a type reachable from it is a checked-dynamic value, a generator, a
 * Dirent row or a class instance, or a record or array that can keep
 * undeclared properties, which can render through a checked-dynamic view. */
function inspectMayRefuse(lowerer: Lowerer, t: IrType): boolean {
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    if (u.kind === "dyn" || u.kind === "generator") return true;
    if (u.kind === "record") {
      const shape = lowerer.shapes.get(u.shapeId);
      if (shape && isDirentShape(shape)) return true;
      // The kept source properties render through the checked view (the
      // helper's source gate).
      if (recordMayKeepSource(lowerer, u)) return true;
    }
    // So do an array's properties besides its elements.
    if (u.kind === "array" && lowerer.dynConvertible(u)) return true;
    // A class instance can render through its checked-dynamic view, which
    // a helper built earlier may only learn at the end of lowering
    // (classInspectsAddedProperties).
    if (u.kind === "object") return true;
    const k = typeKey(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return typeConstituents(lowerer, u).some(walk);
  };
  return walk(t);
}

function inspectExprBody(
  lowerer: Lowerer,
  t: IrType,
  value: IrExpr,
  recurse: IrExpr,
  depth: IrExpr,
  loc: SrcLoc,
  ownRendering: boolean,
): IrExpr {
  // A Dirent row renders through its dyn view: Node's `Dirent { ... }`
  // with the Symbol(type) key.
  if (t.kind === "record") {
    const shape = lowerer.shapes.get(t.shapeId);
    if (shape && isDirentShape(shape)) {
      return {
        kind: "libCall",
        fn: "insp.dyn",
        args: [lowerer.coerceToExpected(value, DYN), recurse, depth],
        type: STRING,
        loc,
      };
    }
  }
  switch (t.kind) {
    case "f64":
      return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
    case "string":
      return { kind: "libCall", fn: "insp.str", args: [value], type: STRING, loc };
    case "bool":
      return { kind: "toString", operand: value, type: STRING, loc };
    case "undefinedT":
      return strLit("undefined", loc);
    case "nullT":
      return strLit("null", loc);
    case "regex":
      return { kind: "libCall", fn: "insp.regex", args: [value], type: STRING, loc };
    case "symbol":
      // inspect(sym) IS Symbol.prototype.toString's text ("Symbol(foo)")
      // — Node prints it unquoted at every depth.
      return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc };
    case "bigint":
      return { kind: "libCall", fn: "bigint.inspect", args: [value], type: STRING, loc };
    case "date":
      // Node prints a Date's toISOString() at every depth, and its
      // toString() ("Invalid Date") when the time value is NaN.
      return { kind: "libCall", fn: "insp.date", args: [value], type: STRING, loc };
    case "bytes":
      if (t.elem !== "u8") {
        return {
          kind: "libCall",
          fn: "insp.typedArray",
          args: [value, recurse, depth],
          type: STRING,
          loc,
        };
      }
      // A Uint8Array, a Buffer and a DataView share the u8 representation
      // and print differently: the view's own flags pick.
      return {
        kind: "libCall",
        fn: "insp.bytes",
        args: [value, recurse, depth],
        type: STRING,
        loc,
      };
    case "dyn":
      return { kind: "libCall", fn: "insp.dyn", args: [value, recurse, depth], type: STRING, loc };
    // URLs and URLSearchParams render through their checked-dynamic
    // handles: Node's `URL { href: ..., hash: ... }` and
    // `URLSearchParams { 'a' => '1' }`.
    case "url":
    case "searchParams":
      return {
        kind: "libCall",
        fn: "insp.dyn",
        args: [lowerer.coerceToExpected(value, DYN), recurse, depth],
        type: STRING,
        loc,
      };
    case "generator":
      return {
        kind: "libCall",
        fn: "insp.dyn",
        args: [lowerer.coerceToExpected(value, DYN), recurse, depth],
        type: STRING,
        loc,
      };
    case "object":
      if (!ownRendering && customInspectMethodOf(lowerer, t.className)) {
        return {
          kind: "call",
          callee: customInspectHelper(lowerer, t, loc),
          args: [value, recurse, depth],
          type: STRING,
          loc,
        };
      }
      if (
        eventTargetRootOf(lowerer.classes.get(t.className)) !== null ||
        dateRootOf(lowerer.classes.get(t.className)) !== null
      ) {
        return {
          kind: "libCall",
          fn: "insp.dyn",
          args: [lowerer.coerceToExpected(value, DYN), recurse, depth],
          type: STRING,
          loc,
        };
      }
      if (isErrorClass(lowerer, t.className)) {
        const info = lowerer.classes.get(t.className);
        if (info && userErrorClasses(info).length > 0) {
          return {
            kind: "call",
            callee: errorInspectHelper(lowerer, t, info, loc),
            args: [value, recurse, depth],
            type: STRING,
            loc,
          };
        }
        return {
          kind: "libCall",
          fn: "insp.error",
          args: [value, recurse, depth],
          type: STRING,
          loc,
        };
      }
      if (classInspectsThroughView(lowerer, lowerer.classes.get(t.className))) {
        return {
          kind: "libCall",
          fn: "insp.dyn",
          args: [lowerer.coerceToExpected(value, DYN), recurse, depth],
          type: STRING,
          loc,
        };
      }
      return {
        kind: "call",
        callee: inspectHelper(lowerer, t, loc),
        args: [value, recurse, depth],
        type: STRING,
        loc,
      };
    default:
      return {
        kind: "call",
        callee: inspectHelper(lowerer, t, loc),
        args: [value, recurse, depth],
        type: STRING,
        loc,
      };
  }
}

/** True when a VALUE of `t` can contain itself — t's type graph reaches t
 * again through record fields (index values included), array elements,
 * union arms, map keys/values, set elements, or class fields. Inspect
 * helpers over such types run Node's circular machinery (seen stack +
 * <ref *N>/[Circular *N]); everything acyclic keeps the zero-cost path
 * (a value of an acyclic type can never repeat on its own path). */
export function typeReachesItself(lowerer: Lowerer, t: IrType): boolean {
  const root = typeKey(t);
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    for (const c of typeConstituents(lowerer, u)) {
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

/** True when a value of `t` can be cyclic: `t` or any type reachable from
 * it reaches itself. */
export function typeReachesCycle(lowerer: Lowerer, t: IrType): boolean {
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    const k = typeKey(u);
    if (seen.has(k)) return false;
    seen.add(k);
    if (typeReachesItself(lowerer, u)) return true;
    return typeConstituents(lowerer, u).some(walk);
  };
  return walk(t);
}

/** True when a value of `t` can hold a function: `t` or any type
 * reachable from it is a function type. */
export function typeReachesFunction(lowerer: Lowerer, t: IrType): boolean {
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    if (u.kind === "func") return true;
    const k = typeKey(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return typeConstituents(lowerer, u).some(walk);
  };
  return walk(t);
}

/** The types a value of `u` holds directly. */
function typeConstituents(lowerer: Lowerer, u: IrType): IrType[] {
  switch (u.kind) {
    case "record": {
      const shape = lowerer.shapes.get(u.shapeId);
      if (!shape) return [];
      const fields = shape.fields.map((f) => f.type);
      return shape.indexValue ? [...fields, shape.indexValue] : fields;
    }
    case "array":
    case "set":
      return [u.elem];
    case "map":
      return [u.key, u.value];
    case "union":
      return lowerer.unions.get(u.unionId)?.arms.slice() ?? [];
    case "object": {
      const info = lowerer.classes.get(u.className);
      if (!info) return [];
      const types = info.def.fields.map((f) => f.type);
      // An error value can be an instance of a program-declared subclass,
      // whose own fields its inspection renders (errorInspectHelper).
      if (isErrorClass(lowerer, u.className))
        for (const c of userErrorClasses(info))
          for (const f of ownErrorFields(c)) types.push(f.type);
      return types;
    }
    default:
      return [];
  }
}

/** Whether instances of a class render through its checked-dynamic view
 * instead of a helper over the declared layout. The view names the
 * instance's own class, which a base-typed value may not know statically,
 * and lists own properties in creation order. A JavaScript class needs that
 * order: its fields can be created conditionally, outside the constructor,
 * or by writes to the instance after construction. */
function classInspectsThroughView(lowerer: Lowerer, info: ClassInfo | undefined): boolean {
  if (info === undefined) return false;
  if (info.subclasses.length > 0) return true;
  return (
    info.decl != null &&
    isJsSourceFile(ts.getSourceFileOfNode(info.decl)) &&
    classDynViewSupported(
      info.def.fields,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  );
}

/** Whether a class holds properties added outside its declared layout, or
 * fields Object.defineProperty can make non-enumerable, which only its
 * checked-dynamic view lists as Node does. Decided after lowering, when the
 * class has its final fields. */
function classInspectsAddedProperties(lowerer: Lowerer, info: ClassInfo): boolean {
  return (
    info.def.fields.some(
      (field) =>
        field.name === DYN_CLASS_PROPERTIES || field.name.startsWith(CLASS_FIELD_ATTRIBUTES_PREFIX),
    ) &&
    classDynViewSupported(
      info.def.fields,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
  );
}

/* ── custom inspect methods ([util.inspect.custom]) ──────────────────── */

/** The `[util.inspect.custom]` method a class's instances have, declared
 * on the class or a base; null when they have none. */
function customInspectMethodOf(lowerer: Lowerer, className: string) {
  const info = lowerer.classes.get(className);
  return info ? (lowerer.findMethodOn(info, INSPECT_CUSTOM_MEMBER) ?? null) : null;
}

/** Why instances of a class with a custom inspect method have no static
 * rendering, or null. Node calls the method with the remaining depth, the
 * options and util.inspect; the method's parameters receive them as
 * checked-dynamic values, and its result renders in the instance's place. */
function customInspectReason(lowerer: Lowerer, info: ClassInfo): string | null {
  const found = lowerer.findMethodOn(info, INSPECT_CUSTOM_MEMBER);
  if (!found) {
    const below = (c: ClassInfo): boolean =>
      c.subclasses.some((s) => s.methods.has(INSPECT_CUSTOM_MEMBER) || below(s));
    return below(info)
      ? "classes whose subclasses declare [util.inspect.custom] have no inspect lowering yet (declare the method on the class itself)"
      : null;
  }
  if (found.sig.params.length > 3)
    return "[util.inspect.custom] methods with more than three parameters have no inspect lowering";
  for (const param of found.sig.params) {
    if (
      param.type.kind !== "dyn" &&
      !canDynCheckTo(
        param.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    )
      return `[util.inspect.custom] methods with a '${lowerer.fmt(param.type)}' parameter have no inspect lowering`;
  }
  const ret = found.sig.ret;
  if (ret.kind === "object")
    return "[util.inspect.custom] methods that return a class instance have no inspect lowering";
  if (
    ret.kind !== "string" &&
    ret.kind !== "dyn" &&
    ret.kind !== "void" &&
    inspectSupport(lowerer, ret, new Set(), { recursive: false }) !== null
  )
    return `[util.inspect.custom] methods returning '${lowerer.fmt(ret)}' have no inspect lowering`;
  return null;
}

/** Whether values of `t` can hold a checked-dynamic value, whose own custom
 * inspect functions the runtime walk calls. */
function typeReachesDyn(lowerer: Lowerer, t: IrType): boolean {
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    if (u.kind === "dyn") return true;
    const k = typeKey(u);
    if (seen.has(k)) return false;
    seen.add(k);
    return typeConstituents(lowerer, u).some(walk);
  };
  return walk(t);
}

/** Whether values of `t` can hold an instance of a class with a custom
 * inspect method. */
export function typeReachesCustomInspect(lowerer: Lowerer, t: IrType): boolean {
  const seen = new Set<string>();
  const walk = (u: IrType): boolean => {
    const k = typeKey(u);
    if (seen.has(k)) return false;
    seen.add(k);
    if (u.kind === "object" && customInspectMethodOf(lowerer, u.className)) return true;
    return typeConstituents(lowerer, u).some(walk);
  };
  return walk(t);
}

/** `%util.inspCustom.<n>(v, r, d): string` — formatValue's custom hook
 * over a class whose instances have a `[util.inspect.custom]` method:
 * with ctx.customInspect set, the method's result (a string re-indented
 * at the current level, the instance itself rendered normally, any other
 * value rendered in its place); otherwise the instance's own rendering. */
function customInspectHelper(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
  loc: SrcLoc,
): string {
  const key = `inspCustom:${typeKey(t)}`;
  const existing = lowerer.inspectHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%util.inspCustom", key);
  lowerer.inspectHelpers.set(key, name);
  const found = customInspectMethodOf(lowerer, t.className)!;
  const v = (): IrExpr => varRef("v.0", t, loc);
  const r = (): IrExpr => varRef("r.0", F64, loc);
  const d = (): IrExpr => varRef("d.0", F64, loc);
  const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
  const normal = (): IrExpr => inspectExpr(lowerer, t, v(), r(), d(), loc, true);
  const runtimeArgs: IrExpr[] = [
    { kind: "libCall", fn: "insp.customDepth", args: [r(), d()], type: DYN, loc },
    { kind: "libCall", fn: "insp.customOptions", args: [d()], type: DYN, loc },
    { kind: "libCall", fn: "insp.inspectFunction", args: [], type: DYN, loc },
  ];
  const locals: IrLocal[] = [
    { id: "v.0", name: "v", type: t, mutable: false },
    { id: "r.0", name: "r", type: F64, mutable: false },
    { id: "d.0", name: "d", type: F64, mutable: false },
  ];
  // The arguments read the walk's depth and options, so they evaluate
  // before the method's own context begins.
  const argDecls: IrStmt[] = found.sig.params.map((param, i) => {
    locals.push({ id: `arg${i}.0`, name: `arg${i}`, type: param.type, mutable: false });
    const init = lowerer.coerceToExpected(runtimeArgs[i]!, param.type);
    return { kind: "varDecl", localId: `arg${i}.0`, init, loc };
  });
  const args = found.sig.params.map((param, i) => varRef(`arg${i}.0`, param.type, loc));
  const resultT = found.sig.ret;
  const call = accessorCall(lowerer, t.className, INSPECT_CUSTOM_MEMBER, v(), args, resultT, loc);
  // The method runs in a fresh inspect context (insp.customCallBegin); the
  // walk's own context returns before the result renders. The token lets
  // an enclosing end restore this walk's context when the method throws.
  locals.push({ id: "tok.0", name: "tok", type: F64, mutable: false });
  const end: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "insp.customCallEnd",
      args: [varRef("tok.0", F64, loc)],
      type: VOID,
      loc,
    },
    loc,
  };
  const render: IrStmt[] = [
    ...argDecls,
    {
      kind: "varDecl",
      localId: "tok.0",
      init: { kind: "libCall", fn: "insp.customCallBegin", args: [], type: F64, loc },
      loc,
    },
  ];
  if (resultT.kind === "void") {
    render.push({ kind: "exprStmt", expr: call, loc }, end);
  } else {
    locals.push({ id: "res.0", name: "res", type: resultT, mutable: false });
    render.push({ kind: "varDecl", localId: "res.0", init: call, loc }, end);
  }
  const res = (): IrExpr => varRef("res.0", resultT, loc);
  if (resultT.kind === "string") {
    render.push(ret({ kind: "libCall", fn: "insp.customText", args: [res()], type: STRING, loc }));
  } else if (resultT.kind === "dyn") {
    render.push(
      {
        kind: "if",
        cond: {
          kind: "libCall",
          fn: "insp.customIsSelf",
          args: [res(), { kind: "dynFrom", value: v(), liveRef: true, type: DYN, loc }],
          type: BOOL,
          loc,
        },
        then: [ret(normal())],
        else_: null,
        loc,
      },
      ret({ kind: "libCall", fn: "insp.customResult", args: [res(), r(), d()], type: STRING, loc }),
    );
  } else if (resultT.kind === "void") {
    render.push(ret(strLit("undefined", loc)));
  } else {
    render.push(ret(inspectExpr(lowerer, resultT, res(), r(), d(), loc)));
  }
  lowerer.liftedFns.push({
    name,
    params: [
      { localId: "v.0", name: "v", type: t },
      { localId: "r.0", name: "r", type: F64 },
      { localId: "d.0", name: "d", type: F64 },
    ],
    returnType: STRING,
    locals,
    body: [
      {
        kind: "if",
        cond: { kind: "libCall", fn: "insp.customEnabled", args: [], type: BOOL, loc },
        then: render,
        else_: null,
        loc,
      },
      ret(normal()),
    ],
    loc,
  });
  return name;
}

/** `%util.inspCustomDyn.<n>(self, depth, options, inspect): dyn` — a
 * class's custom inspect method for its instances held as checked-dynamic
 * values: the runtime's inspect walk calls it with the instance's typed
 * ref and the method's three arguments. */
function customInspectDynHelper(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
  loc: SrcLoc,
): string {
  const name = keyedHelperName(lowerer, "%util.inspCustomDyn", typeKey(t));
  const found = customInspectMethodOf(lowerer, t.className)!;
  const param = (id: string): IrExpr => varRef(id, DYN, loc);
  const ids = ["depth.0", "options.0", "inspect.0"];
  const call = accessorCall(
    lowerer,
    t.className,
    INSPECT_CUSTOM_MEMBER,
    varRef("v.0", t, loc),
    found.sig.params.map((p, i) => lowerer.coerceToExpected(param(ids[i]!), p.type)),
    found.sig.ret,
    loc,
  );
  const body: IrStmt[] = [
    { kind: "varDecl", localId: "v.0", init: lowerer.coerceToExpected(param("self.0"), t), loc },
  ];
  if (found.sig.ret.kind === "void") {
    body.push(
      { kind: "exprStmt", expr: call, loc },
      { kind: "return", value: dynUndefinedExpr(loc), loc },
    );
  } else {
    body.push({ kind: "return", value: lowerer.coerceToExpected(call, DYN), loc });
  }
  const params = ["self.0", ...ids];
  lowerer.liftedFns.push({
    name,
    params: params.map((id) => ({ localId: id, name: id.slice(0, -2), type: DYN })),
    returnType: DYN,
    locals: [
      ...params.map((id) => ({ id, name: id.slice(0, -2), type: DYN, mutable: false })),
      { id: "v.0", name: "v", type: t, mutable: false },
    ],
    body,
    loc,
  });
  return name;
}

/** The statements %main runs first, in every thread: each class whose
 * instances have a custom inspect method registers its compiled call
 * under its instances' typed-ref type key (scr_insp_register_custom). */
export function customInspectRegistrations(lowerer: Lowerer, loc: SrcLoc): IrStmt[] {
  const stmts: IrStmt[] = [];
  for (const info of lowerer.classes.values()) {
    if (info.def.runtime || info.def.abstract) continue;
    // Error classes register when their own properties render statically
    // (fieldedErrorReason): the others keep no method to call.
    if (isErrorClass(lowerer, info.def.name) && fieldedErrorReason(lowerer, info) !== null)
      continue;
    if (!lowerer.findMethodOn(info, INSPECT_CUSTOM_MEMBER)) continue;
    // Only constructed classes have instances, and only their methods lower
    // (the constructor edge reaches the method).
    if (!lowerer.classCanBeConstructed(info)) continue;
    if (customInspectReason(lowerer, info) !== null) continue;
    const t = { kind: "object" as const, className: info.def.name };
    const fn = customInspectDynHelper(lowerer, t, loc);
    stmts.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "insp.registerCustom",
        args: [
          strLit(typeKey(t), loc),
          {
            kind: "dynFrom",
            value: {
              kind: "closure",
              fnName: fn,
              captures: [],
              type: funcOf([DYN, DYN, DYN, DYN], DYN),
              loc,
            },
            type: DYN,
            loc,
          },
        ],
        type: VOID,
        loc,
      },
      loc,
    });
  }
  return stmts;
}

/* ── the interned per-type helper ────────────────────────────────────── */

/** `%util.insp.<n>(v, r, d): string` — formatValue over the static type:
 * empty composites answer their literals (before the depth check, Node's
 * order), the depth budget answers `[Array]`/`[Object]`/`[Map]`/
 * `[Set]`/`[ClassName]`, and non-empty composites drive the runtime
 * frame engine (begin / entry / end). Registered in the cache BEFORE the
 * body builds, so recursive shapes call themselves by name. */
function inspectHelper(lowerer: Lowerer, t: IrType, loc: SrcLoc): string {
  const key = `insp:${typeKey(t)}`;
  const existing = lowerer.inspectHelpers.get(key);
  if (existing) return existing;
  const name = keyedHelperName(lowerer, "%util.insp", key);
  lowerer.inspectHelpers.set(key, name);

  const v = (): IrExpr => varRef("v.0", t, loc);
  const r = (): IrExpr => varRef("r.0", F64, loc);
  const d = (): IrExpr => varRef("d.0", F64, loc);
  const rPlus1 = (): IrExpr => ({
    kind: "bin",
    op: "+",
    left: r(),
    right: numLit(1, loc),
    type: F64,
    loc,
  });
  const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
  const exprStmt = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });
  // CYCLE-CAPABLE composites (typeReachesItself) run Node's circular
  // machinery: circCheck first (a value already on the traversal stack
  // renders [Circular *N] — before the empty/depth answers, Node's
  // order), seen-push after begin, and refWrap around end's result (end
  // adds the <ref *N> prefix on values the walk found circular). Acyclic types
  // keep the zero-cost path.
  const onCycle =
    (t.kind === "record" || t.kind === "array" || t.kind === "map" || t.kind === "object") &&
    typeReachesItself(lowerer, t);
  const begin = (): IrStmt[] => [
    exprStmt({ kind: "libCall", fn: "insp.begin", args: [rPlus1()], type: { kind: "void" }, loc }),
    ...(onCycle
      ? [
          exprStmt({
            kind: "libCall",
            fn: "insp.seenPush",
            args: [v()],
            type: { kind: "void" },
            loc,
          }),
        ]
      : []),
  ];
  const entry = (s: IrExpr, isNum: IrExpr): IrStmt =>
    exprStmt({ kind: "libCall", fn: "insp.entry", args: [s, isNum], type: { kind: "void" }, loc });
  const end = (
    base: IrExpr,
    b0: IrExpr,
    b1: IrExpr,
    arrayExtras: boolean,
    trailingMore: IrExpr,
  ): IrExpr => {
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
    then: [ret(strLit(placeholder, loc))],
    else_: null,
    loc,
  });
  const child = (elemT: IrType, value: IrExpr): IrExpr =>
    inspectExpr(lowerer, elemT, value, rPlus1(), d(), loc);

  const locals: { id: string; name: string; type: IrType; mutable: boolean }[] = [
    { id: "v.0", name: "v", type: t, mutable: false },
    { id: "r.0", name: "r", type: F64, mutable: false },
    { id: "d.0", name: "d", type: F64, mutable: false },
  ];
  let body: IrStmt[] = [];
  let rebuildShapeOrderBody: (() => void) | null = null;

  switch (t.kind) {
    case "array": {
      const at = (index: IrExpr): IrExpr => ({
        kind: "arrayGet",
        arr: v(),
        index,
        type: t.elem,
        loc,
      });
      const state = (index: IrExpr): IrExpr => ({
        kind: "arrayState",
        arr: v(),
        index,
        type: F64,
        loc,
      });
      const eq = (left: IrExpr, right: IrExpr): IrExpr => ({
        kind: "bin",
        op: "===",
        left,
        right,
        type: BOOL,
        loc,
      });
      const lt = (left: IrExpr, right: IrExpr): IrExpr => ({
        kind: "bin",
        op: "<",
        left,
        right,
        type: BOOL,
        loc,
      });
      const add = (left: IrExpr, right: IrExpr): IrExpr => ({
        kind: "bin",
        op: "+",
        left,
        right,
        type: F64,
        loc,
      });
      const sub = (left: IrExpr, right: IrExpr): IrExpr => ({
        kind: "bin",
        op: "-",
        left,
        right,
        type: F64,
        loc,
      });
      locals.push(
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "s.0", name: "s", type: F64, mutable: true },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "next.0", name: "next", type: F64, mutable: false },
      );
      const n = (): IrExpr => varRef("n.0", F64, loc);
      const shown = (): IrExpr => varRef("s.0", F64, loc);
      const i = (): IrExpr => varRef("i.0", F64, loc);
      const next = (): IrExpr => varRef("next.0", F64, loc);
      const hasMore = (): IrExpr => lt(i(), n());
      // A foreign element (state 3) holds a value outside the element type.
      const foreignElements = elementMayBeForeign(lowerer, t.elem);
      const foreign = (): IrExpr => ({
        kind: "libCall",
        fn: "array.foreign",
        args: [v(), i()],
        type: DYN,
        loc,
      });
      const isNumber = (): IrExpr => ({
        kind: "ternary",
        cond: eq(state(i()), numLit(1, loc)),
        then: isNumberFlag(lowerer, t.elem, () => at(i()), loc),
        else_: foreignElements
          ? {
              kind: "ternary",
              cond: eq(state(i()), numLit(3, loc)),
              then: isNumberFlag(lowerer, DYN, foreign, loc),
              else_: boolLit(false, loc),
              type: BOOL,
              loc,
            }
          : boolLit(false, loc),
        type: BOOL,
        loc,
      });
      const holes = (): IrExpr => ({
        kind: "strConcat",
        left: strLit("<", loc),
        right: {
          kind: "strConcat",
          left: { kind: "toString", operand: sub(next(), i()), type: STRING, loc },
          right: {
            kind: "ternary",
            cond: eq(sub(next(), i()), numLit(1, loc)),
            then: strLit(" empty item>", loc),
            else_: strLit(" empty items>", loc),
            type: STRING,
            loc,
          },
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      });
      body = [
        {
          kind: "varDecl",
          localId: "n.0",
          init: { kind: "arrIntrinsic", method: "length", receiver: v(), args: [], type: F64, loc },
          loc,
        },
        {
          kind: "if",
          cond: eq(n(), numLit(0, loc)),
          then: [ret(strLit("[]", loc))],
          else_: null,
          loc,
        },
        depthGate("[Array]"),
        { kind: "varDecl", localId: "s.0", init: numLit(0, loc), loc },
        { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
        ...begin(),
        {
          kind: "while",
          cond: {
            kind: "logical",
            op: "&&",
            left: hasMore(),
            right: lt(shown(), numLit(100, loc)),
            type: BOOL,
            loc,
          },
          body: [
            {
              kind: "if",
              cond: eq(state(i()), numLit(0, loc)),
              then: [
                {
                  kind: "varDecl",
                  localId: "next.0",
                  init: {
                    kind: "arrIntrinsic",
                    method: "nextPresent",
                    receiver: v(),
                    args: [i()],
                    type: F64,
                    loc,
                  },
                  loc,
                },
                entry(holes(), boolLit(false, loc)),
                { kind: "assign", localId: "i.0", value: next(), loc },
              ],
              else_: [
                entry(
                  {
                    kind: "ternary",
                    cond: eq(state(i()), numLit(1, loc)),
                    then: child(t.elem, at(i())),
                    else_: foreignElements
                      ? {
                          kind: "ternary",
                          cond: eq(state(i()), numLit(3, loc)),
                          then: child(DYN, foreign()),
                          else_: strLit("undefined", loc),
                          type: STRING,
                          loc,
                        }
                      : strLit("undefined", loc),
                    type: STRING,
                    loc,
                  },
                  isNumber(),
                ),
                { kind: "assign", localId: "i.0", value: add(i(), numLit(1, loc)), loc },
              ],
              loc,
            },
            { kind: "assign", localId: "s.0", value: add(shown(), numLit(1, loc)), loc },
          ],
          loc,
        },
        {
          kind: "if",
          cond: hasMore(),
          then: [
            entry(
              { kind: "libCall", fn: "insp.moreItems", args: [sub(n(), i())], type: STRING, loc },
              isNumber(),
            ),
          ],
          else_: null,
          loc,
        },
        ret(end(strLit("", loc), strLit("[", loc), strLit("]", loc), true, hasMore())),
      ];
      break;
    }
    case "record": {
      const shape = lowerer.shapes.get(t.shapeId);
      if (!shape) throw new InternalCompilerError(`inspect of unknown shape ${t.shapeId}`);
      const get = (field: string, type: IrType): IrExpr => ({
        kind: "recordGet",
        obj: v(),
        shapeId: t.shapeId,
        field,
        type,
        loc,
      });
      if (isPerfEntryType(lowerer, t)) {
        // PerformanceEntry's custom inspect: `[PerformanceMark]` past the
        // depth budget, otherwise the class name and a nested inspect of
        // toJSON() one level shallower, in its own context.
        const className: IrExpr = {
          kind: "ternary",
          cond: {
            kind: "strEq",
            negated: false,
            left: get("entryType", STRING),
            right: strLit("mark", loc),
            type: BOOL,
            loc,
          },
          then: strLit("PerformanceMark", loc),
          else_: strLit("PerformanceMeasure", loc),
          type: STRING,
          loc,
        };
        const json = perfEntryJson(lowerer, v(), t, loc);
        const dLess1: IrExpr = {
          kind: "bin",
          op: "-",
          left: d(),
          right: numLit(1, loc),
          type: F64,
          loc,
        };
        locals.push({ id: "in.0", name: "inner", type: STRING, mutable: false });
        body = [
          {
            kind: "if",
            cond: { kind: "bin", op: ">", left: r(), right: d(), type: BOOL, loc },
            then: [ret(concatAll([strLit("[", loc), className, strLit("]", loc)], loc))],
            else_: null,
            loc,
          },
          exprStmt({
            kind: "libCall",
            fn: "insp.nestedBegin",
            args: [],
            type: { kind: "void" },
            loc,
          }),
          {
            kind: "varDecl",
            localId: "in.0",
            init: inspectExpr(lowerer, json.type, json, numLit(0, loc), dLess1, loc),
            loc,
          },
          ret({
            kind: "libCall",
            fn: "insp.nestedEnd",
            args: [className, varRef("in.0", STRING, loc)],
            type: STRING,
            loc,
          }),
        ];
        break;
      }
      if (shape.tuple) {
        // Tuples ARE arrays to Node: bracket form, array-extras grouping.
        if (shape.fields.length === 0) {
          body = [ret(strLit("[]", loc))];
          break;
        }
        body = [depthGate("[Array]"), ...begin()];
        for (const f of shape.fields) {
          body.push(
            entry(
              child(f.type, get(f.name, f.type)),
              isNumberFlag(lowerer, f.type, () => get(f.name, f.type), loc),
            ),
          );
        }
        body.push(
          ret(end(strLit("", loc), strLit("[", loc), strLit("]", loc), true, boolLit(false, loc))),
        );
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
        const ks = (): IrExpr => varRef("ks.0", ksT, loc);
        const n = (): IrExpr => varRef("n.0", F64, loc);
        const i = (): IrExpr => varRef("i.0", F64, loc);
        const k = (): IrExpr => varRef("k.0", STRING, loc);
        // A null-prototype record (Object.groupBy) prints Node's
        // "[Object: null prototype]" base.
        const nullProto = nullProtoRecordShape(lowerer, t) !== null;
        const byProto = (plain: string, bare: string): IrExpr =>
          nullProto
            ? {
                kind: "ternary",
                cond: recordNullProtoTest(v(), t.shapeId, loc),
                then: strLit(bare, loc),
                else_: strLit(plain, loc),
                type: STRING,
                loc,
              }
            : strLit(plain, loc);
        const keyedRead = (): IrExpr => ({
          kind: "recordKeyGet",
          obj: v(),
          shapeId: t.shapeId,
          key: k(),
          overflowOnly: true,
          type: iv,
          loc,
        });
        body = [
          {
            kind: "varDecl",
            localId: "ks.0",
            init: { kind: "recordOvfKeys", obj: v(), shapeId: t.shapeId, type: ksT, loc },
            loc,
          },
          {
            kind: "varDecl",
            localId: "n.0",
            init: {
              kind: "arrIntrinsic",
              method: "length",
              receiver: ks(),
              args: [],
              type: F64,
              loc,
            },
            loc,
          },
          {
            kind: "if",
            cond: { kind: "bin", op: "===", left: n(), right: numLit(0, loc), type: BOOL, loc },
            then: [ret(byProto("{}", "[Object: null prototype] {}"))],
            else_: null,
            loc,
          },
          {
            kind: "if",
            cond: { kind: "bin", op: ">", left: r(), right: d(), type: BOOL, loc },
            then: [ret(byProto("[Object]", "[Object: null prototype]"))],
            else_: null,
            loc,
          },
          ...begin(),
          {
            kind: "for",
            init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
            cond: { kind: "bin", op: "<", left: i(), right: n(), type: BOOL, loc },
            update: {
              kind: "assign",
              localId: "i.0",
              value: { kind: "bin", op: "+", left: i(), right: numLit(1, loc), type: F64, loc },
              loc,
            },
            body: [
              {
                kind: "varDecl",
                localId: "k.0",
                init: { kind: "arrayGet", arr: ks(), index: i(), type: STRING, loc },
                loc,
              },
              entry(
                concatAll(
                  [
                    { kind: "libCall", fn: "insp.key", args: [k()], type: STRING, loc },
                    strLit(": ", loc),
                    child(iv, keyedRead()),
                  ],
                  loc,
                ),
                boolLit(false, loc),
              ),
            ],
            loc,
          },
          ret(
            end(
              byProto("", "[Object: null prototype]"),
              strLit("{", loc),
              strLit("}", loc),
              false,
              boolLit(false, loc),
            ),
          ),
        ];
        break;
      }
      if (shape.fields.length === 0) {
        body = [ret(strLit("{}", loc))];
        break;
      }
      // Object.keys' declared order (SEMANTICS.md 36's stance). Retained
      // reachability can settle this shape after the helper is first
      // interned, so rebuild the field walk once metadata is final.
      lowerer.keyOrder.observe(t);
      rebuildShapeOrderBody = (): void => {
        const current = lowerer.shapes.get(t.shapeId) ?? shape;
        const order = current.declaredOrder ?? current.fields.map((f) => f.name);
        const byName = new Map(current.fields.map((f) => [f.name, f.type] as const));
        // Optional fields render only while present (an omitted or
        // deleted property is not shown; an explicit undefined is). A
        // value whose fields are all absent is Node's empty `{}`, which
        // answers before the depth gate.
        const presence = order
          .filter((fname) => byName.has(fname))
          .map((fname) => lowerer.recordFieldPresent(v(), t.shapeId, fname, loc));
        body = [];
        if (presence.length > 0 && presence.every((p) => p.kind === "recordHas")) {
          const any = presence
            .slice(1)
            .reduce<IrExpr>(
              (left, right) => ({ kind: "logical", op: "||", left, right, type: BOOL, loc }),
              presence[0]!,
            );
          body.push({
            kind: "if",
            cond: { kind: "unary", op: "!", operand: any, type: BOOL, loc },
            then: [ret(strLit("{}", loc))],
            else_: null,
            loc,
          });
        }
        body.push(depthGate("[Object]"), ...begin());
        // One walk per key order (see perKeyOrder).
        const orders = shapeKeyOrders(current);
        const walks = orders.map((): IrStmt[] => []);
        for (const [k, fname] of orders.flatMap((order, k) =>
          order.map((name) => [k, name] as const),
        )) {
          const ft = byName.get(fname);
          if (!ft) continue;
          const show = entry(
            concatAll([strLit(`${inspectKey(fname)}: `, loc), child(ft, get(fname, ft))], loc),
            boolLit(false, loc),
          );
          const present = lowerer.recordFieldPresent(v(), t.shapeId, fname, loc);
          walks[k]!.push(
            present.kind === "recordHas"
              ? { kind: "if", cond: present, then: [show], else_: null, loc }
              : show,
          );
        }
        body.push(...perKeyOrder(current, v(), walks, loc));
        body.push(
          ret(end(strLit("", loc), strLit("{", loc), strLit("}", loc), false, boolLit(false, loc))),
        );
      };
      rebuildShapeOrderBody();
      break;
    }
    case "map":
    case "set": {
      const isMap = t.kind === "map";
      const mi = (method: string, args: IrExpr[], type: IrType): IrExpr =>
        isMap
          ? ({
              kind: "mapIntrinsic",
              method: method as "size",
              receiver: v(),
              args,
              type,
              loc,
            } as IrExpr)
          : ({
              kind: "setIntrinsic",
              method: method as "size",
              receiver: v(),
              args,
              type,
              loc,
            } as IrExpr);
      locals.push(
        { id: "n.0", name: "n", type: F64, mutable: false },
        { id: "i.0", name: "i", type: F64, mutable: true },
        { id: "c.0", name: "c", type: F64, mutable: true },
      );
      const n = (): IrExpr => varRef("n.0", F64, loc);
      const i = (): IrExpr => varRef("i.0", F64, loc);
      const c = (): IrExpr => varRef("c.0", F64, loc);
      const label = isMap ? "Map" : "Set";
      const keyT = isMap
        ? (t as IrType & { kind: "map" }).key
        : (t as IrType & { kind: "set" }).elem;
      const hasMore = (): IrExpr => ({
        kind: "bin",
        op: ">",
        left: n(),
        right: numLit(100, loc),
        type: BOOL,
        loc,
      });
      const entryValue = (): IrExpr => {
        const k = child(keyT, mi("iterKey", [i()], keyT));
        if (!isMap) return k;
        const valueT = (t as IrType & { kind: "map" }).value;
        return concatAll(
          [k, strLit(" => ", loc), child(valueT, mi("iterValue", [i()], valueT))],
          loc,
        );
      };
      body = [
        { kind: "varDecl", localId: "n.0", init: mi("size", [], F64), loc },
        {
          kind: "if",
          cond: { kind: "bin", op: "===", left: n(), right: numLit(0, loc), type: BOOL, loc },
          then: [ret(strLit(`${label}(0) {}`, loc))],
          else_: null,
          loc,
        },
        depthGate(`[${label}]`),
        ...begin(),
        { kind: "varDecl", localId: "c.0", init: numLit(0, loc), loc },
        {
          kind: "for",
          init: { kind: "varDecl", localId: "i.0", init: numLit(0, loc), loc },
          cond: {
            kind: "bin",
            op: "<",
            left: i(),
            right: mi("iterCount", [], F64),
            type: BOOL,
            loc,
          },
          update: {
            kind: "assign",
            localId: "i.0",
            value: { kind: "bin", op: "+", left: i(), right: numLit(1, loc), type: F64, loc },
            loc,
          },
          body: [
            {
              kind: "if",
              cond: {
                kind: "unary",
                op: "!",
                operand: mi("iterLive", [i()], BOOL),
                type: BOOL,
                loc,
              },
              then: [{ kind: "continue", loc }],
              else_: null,
              loc,
            },
            {
              kind: "if",
              cond: { kind: "bin", op: "===", left: c(), right: numLit(100, loc), type: BOOL, loc },
              then: [{ kind: "break", loc }],
              else_: null,
              loc,
            },
            entry(entryValue(), boolLit(false, loc)),
            {
              kind: "assign",
              localId: "c.0",
              value: { kind: "bin", op: "+", left: c(), right: numLit(1, loc), type: F64, loc },
              loc,
            },
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
                args: [
                  { kind: "bin", op: "-", left: n(), right: numLit(100, loc), type: F64, loc },
                ],
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
            strLit("", loc),
            concatAll(
              [
                strLit(`${label}(`, loc),
                { kind: "toString", operand: n(), type: STRING, loc },
                strLit(") {", loc),
              ],
              loc,
            ),
            strLit("}", loc),
            false,
            hasMore(),
          ),
        ),
      ];
      break;
    }
    case "union": {
      const def = lowerer.unions.get(t.unionId);
      if (!def) throw new InternalCompilerError(`inspect of unknown union ${t.unionId}`);
      body = [];
      def.arms.forEach((arm, tag) => {
        // The union wrapper is not a nesting level: arms render at the
        // SAME recursion depth (formatValue dispatches on the value).
        const narrowed: IrExpr = {
          kind: "unionNarrow",
          unionId: t.unionId,
          tag,
          value: v(),
          type: arm,
          loc,
        };
        body.push({
          kind: "if",
          cond: {
            kind: "unionIsTag",
            unionId: t.unionId,
            tag,
            negated: false,
            value: v(),
            type: BOOL,
            loc,
          },
          then: [ret(inspectExpr(lowerer, arm, narrowed, r(), d(), loc))],
          else_: null,
          loc,
        });
      });
      body.push(ret(strLit("", loc))); // unreachable: some arm always matches
      break;
    }
    case "object": {
      const info = lowerer.classes.get(t.className);
      if (!info) throw new InternalCompilerError(`inspect of unknown class ${t.className}`);
      // Node prints the class's OWN name — the declaration's, never the
      // IR name's module qualifier (`m0.Timer` is the frontend's spelling
      // for a class declared in a non-entry module).
      const display = info.def.jsName ?? info.decl?.name?.text ?? info.def.name.replace(/^%/, "");
      // #private fields never render: they are not properties in any
      // observable way — Node's inspect omits them entirely (verified),
      // so a class whose only fields are private prints as `C {}`.
      const visible = info.def.fields.filter((f) => isClassOwnEnumerableFieldName(f.name));
      // A Symbol.toStringTag getter (an own tag field is listed instead)
      // brackets the tag after the name, `Name [tag] {`, when it is a
      // nonempty string other than the name. A getter that throws shows
      // no tag, as in Node.
      const tagGetter = info.fields.has(TO_STRING_TAG_FIELD)
        ? null
        : findMethodOn(lowerer, info, "get:sym:toStringTag");
      let named: (plain: string, make: (head: IrExpr) => IrExpr) => IrExpr = (plain) =>
        strLit(plain, loc);
      if (tagGetter?.sig.ret.kind === "string") {
        const owner = tagGetter.declarer.def.name;
        locals.push(
          { id: "tag.0", name: "tag", type: STRING, mutable: true },
          { id: "tagError.0", name: "tagError", type: CAUGHT, mutable: false },
        );
        body.push(
          { kind: "varDecl", localId: "tag.0", init: strLit("", loc), loc },
          {
            kind: "tryCatch",
            tryBody: [
              {
                kind: "assign",
                localId: "tag.0",
                value: accessorCall(
                  lowerer,
                  owner,
                  "get:sym:toStringTag",
                  lowerer.upcastTo(v(), owner),
                  [],
                  STRING,
                  loc,
                ),
                loc,
              },
            ],
            catchBody: [],
            catchLocalId: "tagError.0",
            finallyBody: null,
            loc,
          },
        );
        const tag = (): IrExpr => varRef("tag.0", STRING, loc);
        const shown: IrExpr = {
          kind: "logical",
          op: "&&",
          left: {
            kind: "strEq",
            negated: true,
            left: tag(),
            right: strLit("", loc),
            type: BOOL,
            loc,
          },
          right: {
            kind: "strEq",
            negated: true,
            left: tag(),
            right: strLit(display, loc),
            type: BOOL,
            loc,
          },
          type: BOOL,
          loc,
        };
        const head = concatAll(
          [strLit(`${display === "" ? "Object" : display} [`, loc), tag(), strLit("]", loc)],
          loc,
        );
        named = (plain, make) => ({
          kind: "ternary",
          cond: shown,
          then: make(head),
          else_: strLit(plain, loc),
          type: STRING,
          loc,
        });
      }
      const after = (text: string) => (head: IrExpr) => concatAll([head, strLit(text, loc)], loc);
      if (visible.length === 0) {
        body.push(ret(named(display === "" ? "{}" : `${display} {}`, after(" {}"))));
        break;
      }
      const get = (field: string, type: IrType): IrExpr => ({
        kind: "fieldGet",
        obj: v(),
        className: t.className,
        field,
        type,
        loc,
      });
      body.push(
        {
          kind: "if",
          cond: { kind: "bin", op: ">", left: r(), right: d(), type: BOOL, loc },
          then: [
            ret(
              named(display === "" ? "[Object]" : `[${display}]`, (head) =>
                concatAll([strLit("[", loc), head, strLit("]", loc)], loc),
              ),
            ),
          ],
          else_: null,
          loc,
        },
        ...begin(),
      );
      // def.fields carries layout order: the base chain first, then own —
      // exactly the own-property insertion order of a constructor that
      // assigns in declaration order (SEMANTICS.md 36's stance). SYMBOL-
      // keyed fields render LAST ([[OwnPropertyKeys]] lists all string
      // keys before all symbol keys — Node's inspect order) and their
      // reserved layout names carry Node's key spelling (`Symbol(limit)`),
      // printed verbatim after removing the internal slot prefix.
      const symNames = new Set<string>();
      if (info.symbolFields) {
        for (const [, name] of info.symbolFields) symNames.add(name);
      }
      const ordered = [
        ...visible.filter((f) => !symNames.has(f.name)),
        ...visible.filter((f) => symNames.has(f.name)),
      ];
      for (const f of ordered) {
        const key = symNames.has(f.name) ? symbolFieldDisplayName(f.name) : inspectKey(f.name);
        body.push(
          entry(
            concatAll([strLit(`${key}: `, loc), child(f.type, get(f.name, f.type))], loc),
            boolLit(false, loc),
          ),
        );
      }
      body.push(
        ret(
          end(
            strLit("", loc),
            named(display === "" ? "{" : `${display} {`, after(" {")),
            strLit("}", loc),
            false,
            boolLit(false, loc),
          ),
        ),
      );
      break;
    }
    default:
      throw new InternalCompilerError(`inspect helper over unexpected type ${typeKey(t)}`);
  }

  // A closed record that kept the undeclared properties of its checked
  // source renders through its live checked view, which holds them in the
  // source's own-key order beside the current field values. An array with
  // properties besides its elements does too: the view lists them after
  // the elements.
  let prependSourceGate: (() => void) | null = null;
  const sourceTest: IrExpr | null =
    t.kind === "record" && recordMayKeepSource(lowerer, t)
      ? recordSourceTest(v(), loc)
      : t.kind === "array" && lowerer.dynConvertible(t)
        ? { kind: "libCall", fn: "array.hasProperties", args: [v()], type: BOOL, loc }
        : null;
  if (sourceTest !== null) {
    prependSourceGate = (): void => {
      body.unshift({
        kind: "if",
        cond: sourceTest,
        then: [
          ret({
            kind: "libCall",
            fn: "insp.dyn",
            args: [{ kind: "dynFrom", value: v(), liveRef: true, type: DYN, loc }, r(), d()],
            type: STRING,
            loc,
          }),
        ],
        else_: null,
        loc,
      });
    };
    prependSourceGate();
  }

  let prependCycleGuard: (() => void) | null = null;
  if (onCycle) {
    // The circular check, FIRST (before the empty-literal and depth
    // answers): a value already on the traversal stack renders
    // [Circular *N] and descends no further — Node's formatValue order
    // (a circular target beyond the depth budget still says Circular).
    locals.push({ id: "cc.0", name: "cc", type: F64, mutable: false });
    const cc = (): IrExpr => varRef("cc.0", F64, loc);
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
          cond: { kind: "bin", op: ">", left: cc(), right: numLit(0, loc), type: BOOL, loc },
          then: [ret({ kind: "libCall", fn: "insp.circular", args: [cc()], type: STRING, loc })],
          else_: null,
          loc,
        },
      );
    };
    prependCycleGuard();
  }

  // Typed as the IR function itself: the finalizer below replaces the
  // body of the very object liftedFns holds (natively, a differently typed
  // literal would be copied into the list).
  const fn: IrFunction = {
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
  const inspected = t.kind === "object" ? lowerer.classes.get(t.className) : undefined;
  if (inspected !== undefined) {
    // Dynamic stores add a property bag to the class after this helper was
    // built. The checked-dynamic view lists the bag's properties after the
    // declared fields, so a class that has one renders through the view.
    lowerer.shapeOrderHelperFinalizers.push(() => {
      if (!classInspectsAddedProperties(lowerer, inspected)) return;
      fn.body = [
        ret({
          kind: "libCall",
          fn: "insp.dyn",
          args: [{ kind: "dynFrom", value: v(), liveRef: true, type: DYN, loc }, r(), d()],
          type: STRING,
          loc,
        }),
      ];
    });
  }
  if (rebuildShapeOrderBody !== null) {
    lowerer.shapeOrderHelperFinalizers.push(() => {
      rebuildShapeOrderBody!();
      prependSourceGate?.();
      prependCycleGuard?.();
      fn.body = body;
    });
  }
  lowerer.liftedFns.push(fn);
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
function formatValueExpr(
  lowerer: Lowerer,
  t: IrType,
  value: IrExpr,
  depth: number,
  loc: SrcLoc,
): IrExpr {
  switch (t.kind) {
    case "string":
      return value;
    case "f64":
      return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
    case "bool":
      return { kind: "toString", operand: value, type: STRING, loc };
    case "undefinedT":
      return strLit("undefined", loc);
    case "nullT":
      return strLit("null", loc);
    case "symbol":
      return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc };
    case "bigint":
      return { kind: "libCall", fn: "bigint.inspect", args: [value], type: STRING, loc };
    case "dyn":
      return {
        kind: "libCall",
        fn: "insp.dynS",
        args: [value, numLit(depth, loc)],
        type: STRING,
        loc,
      };
    case "union":
      return {
        kind: "call",
        callee: formatUnionHelper(lowerer, t, depth, loc),
        args: [value],
        type: STRING,
        loc,
      };
    default:
      return inspectExpr(lowerer, t, value, numLit(0, loc), numLit(depth, loc), loc);
  }
}

/** `%util.fmtv.<n>(v): string` — formatValueExpr's runtime dispatch over a
 * union's arms (interned per union + depth, the inspectHelper pattern).
 * The TOP-LEVEL union rule only: nested unions inside composites keep
 * inspect's own rendering, where string arms quote — exactly Node. */
function formatUnionHelper(
  lowerer: Lowerer,
  t: IrType & { kind: "union" },
  depth: number,
  site: SrcLoc,
): string {
  const key = `fmtv:${typeKey(t)}:${depth}`;
  const existing = lowerer.inspectHelpers.get(key);
  if (existing) return existing;
  const loc = helperLoc(site);
  const name = keyedHelperName(lowerer, "%util.fmtv", key);
  lowerer.inspectHelpers.set(key, name);
  const def = lowerer.unions.get(t.unionId);
  if (!def) throw new InternalCompilerError(`format value over unknown union ${t.unionId}`);
  const v = (): IrExpr => ({ kind: "varRef", localId: "v.0", type: t, loc });
  const body: IrStmt[] = [];
  def.arms.forEach((arm, tag) => {
    const narrowed: IrExpr = {
      kind: "unionNarrow",
      unionId: t.unionId,
      tag,
      value: v(),
      type: arm,
      loc,
    };
    body.push({
      kind: "if",
      cond: {
        kind: "unionIsTag",
        unionId: t.unionId,
        tag,
        negated: false,
        value: v(),
        type: BOOL,
        loc,
      },
      then: [{ kind: "return", value: formatValueExpr(lowerer, arm, narrowed, depth, loc), loc }],
      else_: null,
      loc,
    });
  });
  body.push({ kind: "return", value: strLit("", loc), loc }); // unreachable: some arm always matches
  lowerer.liftedFns.push({
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
  lowerer: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  surface: string,
  loc: SrcLoc,
): IrExpr {
  const t = value.type;
  if (t.kind === "undefinedT" || t.kind === "nullT") {
    // The baked text ("undefined"/"null"): the operand is a literal or a
    // pure read, so dropping its evaluation loses nothing. Effectful
    // unit-typed operands report SC1090 instead of being skipped.
    if (value.kind !== "unitLit" && !isSafeToRepeat(value)) {
      lowerer.unsupported(
        "SC1090",
        node,
        `${surface} of an effectful '${lowerer.fmt(t)}'-typed expression (evaluate it first: const v = ...; ${surface}(v))`,
      );
    }
    return strLit(t.kind === "undefinedT" ? "undefined" : "null", loc);
  }
  if (t.kind === "bytes") {
    // One runtime representation serves Buffer AND Uint8Array; their
    // renderings differ, so the argument's checker type picks
    // (lowerInspectCall's stance).
    const tname = lowerer.checker.typeToString(
      lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(node)),
    );
    if (isDataViewTypeName(tname)) {
      lowerer.unsupported(
        "SC1090",
        node,
        `${surface} of '${tname}' values (Buffer and the numeric typed arrays are the lowered byte renderings; DataView has none yet)`,
      );
    }
    if (!isBufferTypeName(tname)) {
      // A u8 value the checker types as a Uint8Array may still hold a
      // Buffer, which Node prints as one: the view's flags pick.
      return {
        kind: "libCall",
        fn: t.elem === "u8" ? "insp.bytes" : "insp.typedArray",
        args: [value, numLit(0, loc), numLit(2, loc)],
        type: STRING,
        loc,
      };
    }
    return { kind: "libCall", fn: "insp.buffer", args: [value], type: STRING, loc };
  }
  if (t.kind === "void") {
    // Node prints "undefined" for a void call's result; a void expression
    // is not a value here, so the composition fences with the rewrite.
    lowerer.unsupported(
      "SC1090",
      node,
      `${surface} of a void call result (call it as its own statement, then ${surface}(undefined))`,
    );
  }
  // A read that always throws (an ambient name, a binding whose
  // initializer threw) never produces a value to render.
  if (value.kind === "libCall" && value.fn === "global.undefRead")
    return formatValueExpr(lowerer, DYN, { ...value, type: DYN }, 2, loc);
  const walk = { recursive: false };
  const reason = inspectSupport(lowerer, t, new Set(), walk);
  if (reason !== null) {
    lowerer.unsupported("SC1090", node, `${surface} of '${lowerer.fmt(t)}' values (${reason})`);
  }
  return formatValueExpr(lowerer, t, value, 2, loc);
}

/** The checker's spelling of a Buffer, whose bytes print as <Buffer ..>. */
function isBufferTypeName(tname: string): boolean {
  return (
    tname === "Buffer" ||
    tname === "NonSharedBuffer" ||
    tname.startsWith("Buffer<") ||
    tname.startsWith("NonSharedBuffer<")
  );
}

function isDataViewTypeName(tname: string): boolean {
  return tname === "DataView" || tname.startsWith("DataView<");
}

/* ── the callsite: options, direct function/class names ──────────────── */

/** The parsed options literal: the resolved depth (numeric; Infinity for
 * `null`), breakLength (numeric; default 80) and compact (numeric, -1 for
 * false; default 3), with every other non-default knob fenced by name. */
interface InspectOptions {
  depth: number;
  breakLength: number;
  compact: number;
  sorted: boolean;
  /** Set by the `atRunTime` parse: colors or a computed knob value, which
   * the runtime reads. */
  runtime: boolean;
  /** How the depth option was spelled, for custom inspect methods: 0 a
   * number (also when absent), 1 null, 2 undefined. */
  depthKind: number;
  /** customInspect: false skips [util.inspect.custom] methods (console.dir's
   * default). */
  customInspect: boolean;
}

function parseInspectOptions(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  recursive: boolean,
  dir = false,
  atRunTime = false,
): InspectOptions {
  const surface = dir ? "console.dir" : "util.inspect";
  const options: InspectOptions = {
    depth: 2,
    breakLength: 80,
    compact: 3,
    sorted: false,
    runtime: false,
    depthKind: 0,
    customInspect: !dir,
  };
  if (!node || (ts.isIdentifier(node) && node.text === "undefined")) return options;
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      `${surface} with a non-literal options argument`,
      node,
      "the options must be an object literal ({ depth, colors: false, ... }) so the knobs resolve at compile time",
    );
  }
  for (const prop of node.properties.nodes) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      // `{ depth }` and `{ ...base }` hold values known at run time.
      if (atRunTime && (ts.isShorthandPropertyAssignment(prop) || ts.isSpreadAssignment(prop))) {
        options.runtime = true;
        continue;
      }
      lowerer.noLowering(
        `${surface} options in this form`,
        prop,
        "plain `key: literal` entries are the lowered options",
      );
    }
    const key = prop.name.text;
    const value = prop.initializer;
    const numeric = (): number | null => {
      if (ts.isNumericLiteral(value)) return Number(value.text);
      if (
        ts.isPrefixUnaryExpression(value) &&
        value.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(value.operand)
      ) {
        return -Number(value.operand.text);
      }
      return null;
    };
    if (key === "depth") {
      if (
        value.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(value) && value.text === "Infinity")
      ) {
        // Unbounded depth is safe over recursive types too: the circular
        // machinery ([Circular *N]) cuts every cycle, so the walk is
        // bounded by the (finite) object graph — exactly Node.
        void recursive;
        options.depth = Infinity;
        options.depthKind = value.kind === ts.SyntaxKind.NullKeyword ? 1 : 0;
      } else if (ts.isIdentifier(value) && value.text === "undefined") {
        // Node's ctx.depth is undefined: no depth limit.
        options.depth = Infinity;
        options.depthKind = 2;
      } else {
        const n = numeric();
        if (n === null && atRunTime) {
          options.runtime = true;
          continue;
        }
        if (n === null) {
          lowerer.noLowering(
            `${surface} with a non-literal depth option`,
            value,
            "depth must be a numeric literal (or null)",
          );
        }
        options.depth = n;
      }
    } else if (key === "colors") {
      if (value.kind !== ts.SyntaxKind.FalseKeyword && atRunTime) options.runtime = true;
      else if (value.kind !== ts.SyntaxKind.FalseKeyword) {
        lowerer.noLowering(
          `${surface} with colors: true`,
          value,
          "ANSI styling has no lowering — only colors: false",
        );
      }
    } else if (key === "compact") {
      // Node tries the single-line form and groups arrays only for a
      // compact of at least 1; false and smaller numbers break every
      // composite onto its own lines. compact: true is the older layout.
      const n = value.kind === ts.SyntaxKind.FalseKeyword ? 0 : numeric();
      if (n === null && atRunTime && value.kind !== ts.SyntaxKind.TrueKeyword) {
        options.runtime = true;
        continue;
      }
      if (n === null || Number.isNaN(n)) {
        lowerer.noLowering(
          `${surface} with this compact option`,
          value,
          "compact must be false or a numeric literal (compact: true has no lowering)",
        );
      }
      // false is -1: the same layout as 0, and custom inspect functions
      // read it back as false.
      options.compact = value.kind === ts.SyntaxKind.FalseKeyword ? -1 : Math.max(n, 0);
    } else if (key === "sorted") {
      const sortedLiteral =
        value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword;
      if (
        !sortedLiteral &&
        atRunTime &&
        !ts.isArrowFunction(value) &&
        !ts.isFunctionExpression(value)
      ) {
        options.runtime = true;
        continue;
      }
      if (!sortedLiteral) {
        lowerer.noLowering(
          `${surface} with this sorted option`,
          value,
          "sorted must be true or false (a comparator function has no lowering)",
        );
      }
      options.sorted = value.kind === ts.SyntaxKind.TrueKeyword;
    } else if (key === "breakLength") {
      const n = ts.isIdentifier(value) && value.text === "Infinity" ? Infinity : numeric();
      if (n === null && atRunTime) {
        options.runtime = true;
        continue;
      }
      if (n === null || Number.isNaN(n)) {
        lowerer.noLowering(
          `${surface} with a non-literal breakLength option`,
          value,
          "breakLength must be a numeric literal or Infinity",
        );
      }
      options.breakLength = n;
    } else if (
      !dir &&
      key === "customInspect" &&
      (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      options.customInspect = value.kind === ts.SyntaxKind.TrueKeyword;
    } else if (dir && key === "customInspect") {
      // console.dir's own default; only that value is lowered.
      if (value.kind !== ts.SyntaxKind.FalseKeyword) {
        lowerer.noLowering(
          "console.dir with customInspect: true",
          value,
          "only customInspect: false (console.dir's default) is lowered",
        );
      }
    } else {
      lowerer.noLowering(
        `${surface} with the '${key}' option`,
        prop,
        `the lowered options are depth (numeric literal or null), colors: false, compact (false or a number), breakLength, ${dir ? "sorted (true or false), and customInspect: false" : "and sorted (true or false)"}`,
      );
    }
  }
  return options;
}

/** A render under non-default breakLength/compact/sorted: the value is evaluated
 * first, the layout applies to this render only, and the defaults return
 * however the render ends, an inspection refusal included. The render runs
 * in a lifted function, `(v) => { insp.layout(...); try { return render(v); }
 * finally { insp.layout(80, 3, false); } }`, since a seqExpr cannot hold the
 * try; `tag` names the render for the function's key. */
function withInspectLayout(
  lowerer: Lowerer,
  options: InspectOptions,
  value: IrExpr,
  tag: string,
  render: (value: IrExpr) => IrExpr,
  loc: SrcLoc,
): IrExpr {
  if (options.breakLength === 80 && options.compact === 3 && !options.sorted) return render(value);
  const key = `layout:${tag}:${typeKey(value.type)}:${options.breakLength}:${options.compact}:${options.sorted}:${options.depth}`;
  let name = lowerer.inspectHelpers.get(key);
  if (name === undefined) {
    name = keyedHelperName(lowerer, "%util.inspLayout", key);
    lowerer.inspectHelpers.set(key, name);
    const layout = (breakLength: number, compact: number, sorted: boolean): IrStmt => ({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "insp.layout",
        args: [numLit(breakLength, loc), numLit(compact, loc), boolLit(sorted, loc)],
        type: VOID,
        loc,
      },
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "v.0", name: "v", type: value.type }],
      returnType: STRING,
      locals: [{ id: "v.0", name: "v", type: value.type, mutable: false }],
      body: [
        layout(options.breakLength, options.compact, options.sorted),
        {
          kind: "tryCatch",
          tryBody: [{ kind: "return", value: render(varRef("v.0", value.type, loc)), loc }],
          catchBody: null,
          catchLocalId: null,
          finallyBody: [layout(80, 3, false)],
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [value], type: STRING, loc };
}

/** `util.inspect(fn)` / `util.inspect(Cls)` over a DIRECT identifier
 * naming a declared function or class: the name is compile-time truth,
 * so `[Function: name]` / `[class X extends Y]` bake as literals. Null
 * when the identifier is not such a declaration. */
function directCallableInspect(lowerer: Lowerer, node: ts.Expression, loc: SrcLoc): IrExpr | null {
  if (!ts.isIdentifier(node)) return null;
  const sym = lowerer.resolveValueSymbol(node);
  if (!sym) return null;
  const cls = lowerer.classBySymbol.get(sym) ?? lowerer.builtinErrorInfoOf(sym);
  // A rebindable decorated name is not compile-time truth — the binding
  // holds the decoration result; no literal folds.
  if (cls?.classDecorators?.valueGlobalId !== undefined) return null;
  if (cls) {
    if (cls.builtinError) {
      // Node's Error constructors are native functions, not classes.
      return strLit(`[Function: ${cls.def.name.replace(/^%/, "")}]`, loc);
    }
    const base = cls.base ? ` extends ${cls.base.def.name.replace(/^%/, "")}` : "";
    return strLit(`[class ${cls.def.name}${base}]`, loc);
  }
  const decl = sym.declarations[0];
  if (!decl) return null;
  // A JavaScript function can hold own properties (`f.x = 1`, computed
  // keys), which the runtime walk prints after its name.
  if (isJsSourceFile(node.getSourceFile())) {
    const type = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (type?.kind === "func" && lowerer.dynConvertible(type)) return null;
  }
  if (ts.isFunctionDeclaration(decl) && decl.name) {
    return strLit(`[Function: ${decl.name.text}]`, loc);
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
    return strLit(`[Function: ${own ?? decl.name.text}]`, loc);
  }
  return null;
}

/** util.inspect(value[, options]) and inspect(value, showHidden, depth,
 * colors) — the spoke's inspect entry. Options the compiler resolves
 * render through the static helpers; colors, option values known only at
 * run time and the legacy forms render the value's checked-dynamic view
 * in the runtime (insp.inspect). */
function lowerInspectCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = expr.arguments.nodes;
  if (args.length < 1 || args.length > 4 || args.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `util.inspect with ${args.some(ts.isSpreadElement) ? "spread" : args.length} arguments`,
      expr,
      "the supported forms are inspect(value), inspect(value, options) and inspect(value, showHidden, depth, colors)",
    );
  }
  if (args.length <= 2 && !inspectOptionsAtRunTime(lowerer, args[1]))
    return lowerInspectValue(lowerer, args[0]!, args[1], loc, false);
  return lowerRuntimeInspect(lowerer, args, loc);
}

/** Whether an options argument needs the runtime reader: an options value
 * that is not an object literal, or a literal with colors or a computed
 * depth, compact, breakLength or sorted value. Literal options otherwise
 * keep the static parse, which also reports the literal options neither
 * path lowers. */
function inspectOptionsAtRunTime(lowerer: Lowerer, node: ts.Expression | undefined): boolean {
  if (!node || (ts.isIdentifier(node) && node.text === "undefined")) return false;
  if (!ts.isObjectLiteralExpression(node)) return true;
  return parseInspectOptions(lowerer, node, false, false, true).runtime;
}

/** util.inspect over the value's checked-dynamic view, with every argument
 * evaluated in order and read in the runtime as Node's inspect reads it. */
function lowerRuntimeInspect(
  lowerer: Lowerer,
  args: readonly ts.Expression[],
  loc: SrcLoc,
): IrExpr {
  const valueNode = args[0]!;
  if (
    directCallableInspect(lowerer, valueNode, loc) !== null ||
    ts.isArrowFunction(valueNode) ||
    ts.isFunctionExpression(valueNode)
  ) {
    lowerer.noLowering(
      "util.inspect of a function or class with these options",
      valueNode,
      "pass the options as a literal without colors",
    );
  }
  const value = lowerer.lowerExpr(valueNode);
  if (value.type.kind !== "dyn") {
    const reason = inspectSupport(lowerer, value.type, new Set(), { recursive: false });
    if (reason !== null)
      lowerer.noLowering(`util.inspect of '${lowerer.fmt(value.type)}' values`, valueNode, reason);
    if (!lowerer.dynConvertible(value.type))
      lowerer.noLowering(
        `util.inspect with these options of '${lowerer.fmt(value.type)}' values`,
        valueNode,
        "the options are read at run time, where the value renders through its checked-dynamic view",
      );
  }
  const stmts: IrStmt[] = [];
  const held = (init: IrExpr): IrExpr => {
    const local = lowerer.declareHiddenLocal("%inspectArg", DYN);
    stmts.push({ kind: "varDecl", localId: local.id, init, loc });
    return varRef(local.id, DYN, loc);
  };
  const operands: IrExpr[] = [held(lowerer.coerceToExpected(value, DYN))];
  for (let i = 1; i < 4; i++) {
    const node = args[i];
    operands.push(node ? held(lowerer.lowerExprExpecting(node, DYN)) : dynUndefinedExpr(loc));
  }
  operands.push(numLit(args.length, loc));
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "libCall", fn: "insp.inspect", args: operands, type: STRING, loc },
    type: STRING,
    loc,
  };
}

/** `inspect(value, options)` over one value node: the shared body of
 * util.inspect and console.dir. console.dir is Node's `inspect(object,
 * { customInspect: false, ...options })`; the only lowered value with a
 * custom inspect hook is Buffer (its <Buffer ..> form), so that call
 * fences Buffers and routes checked-dynamic values through the runtime
 * walk that refuses a Buffer anywhere inside. */
export function lowerInspectValue(
  lowerer: Lowerer,
  valueNode: ts.Expression,
  optionsNode: ts.Expression | undefined,
  loc: SrcLoc,
  dir: boolean,
): IrExpr {
  const surface = dir ? "console.dir" : "util.inspect";
  // Inline function/class literals and direct declared names render as
  // their baked forms; other function-typed values fence below.
  const direct = directCallableInspect(lowerer, valueNode, loc);
  if (direct) {
    parseInspectOptions(lowerer, optionsNode, false, dir);
    return direct;
  }
  if (ts.isArrowFunction(valueNode) || ts.isFunctionExpression(valueNode)) {
    parseInspectOptions(lowerer, optionsNode, false, dir);
    return strLit(
      valueNode.kind === ts.SyntaxKind.FunctionExpression &&
        (valueNode as ts.FunctionExpression).name
        ? `[Function: ${(valueNode as ts.FunctionExpression).name!.text}]`
        : "[Function (anonymous)]",
      loc,
    );
  }
  let value = lowerer.lowerExpr(valueNode);
  // A JavaScript function renders through the runtime walk, which prints
  // its own properties after its name.
  if (
    value.type.kind === "func" &&
    isJsSourceFile(valueNode.getSourceFile()) &&
    lowerer.dynConvertible(value.type)
  ) {
    const name = jsFuncNameOf(valueNode);
    value = { kind: "dynFrom", value, type: DYN, ...(name !== null ? { fnName: name } : {}), loc };
  }
  if (value.type.kind === "bytes") {
    // One runtime representation serves Buffer AND Uint8Array; their
    // renderings differ (<Buffer aa> vs Uint8Array(1) [ 170 ]), so the
    // TOP-LEVEL argument's checker type picks. Nested u8 bytes fence in
    // inspectSupport (no checker type survives into shapes).
    const tname = lowerer.checker.typeToString(
      lowerer.checker.getBaseTypeOfLiteralType(lowerer.typeOf(valueNode)),
    );
    const isBuffer = isBufferTypeName(tname);
    if (dir && isBuffer) {
      lowerer.noLowering(
        `console.dir of '${tname}' values`,
        valueNode,
        "console.dir disables custom inspection, and the typed-array rendering it falls back to has no lowering yet — use console.log",
      );
    }
    if (isDataViewTypeName(tname)) {
      lowerer.noLowering(
        `util.inspect of '${tname}' values`,
        valueNode,
        "Buffer and the numeric typed arrays are the lowered byte renderings; DataView has none yet",
      );
    }
    const options = parseInspectOptions(lowerer, optionsNode, false, dir);
    if (!isBuffer) {
      // A numeric typed array: Uint8Array(n) [ ... ] under the depth and
      // layout options.
      return withInspectLayout(
        lowerer,
        options,
        value,
        "typedArray",
        (input) => ({
          kind: "libCall",
          fn:
            value.type.kind === "bytes" && value.type.elem === "u8"
              ? "insp.bytes"
              : "insp.typedArray",
          args: [input, numLit(0, loc), numLit(options.depth, loc)],
          type: STRING,
          loc,
        }),
        loc,
      );
    }
    // Buffers render fully at any depth and on one line (custom inspect).
    return { kind: "libCall", fn: "insp.buffer", args: [value], type: STRING, loc };
  }
  const walk = { recursive: false };
  const reason = inspectSupport(lowerer, value.type, new Set(), walk);
  if (reason !== null) {
    lowerer.noLowering(`${surface} of '${lowerer.fmt(value.type)}' values`, valueNode, reason);
  }
  const options = parseInspectOptions(lowerer, optionsNode, walk.recursive, dir);
  const depth = options.depth;
  // Custom inspect functions read the options as Node spelled them: an
  // unbounded depth given as Infinity or undefined, and customInspect:
  // false (console.dir's default), apply around the render when the value
  // can reach a custom method; the previous settings return afterwards.
  const reachesCustom =
    typeReachesCustomInspect(lowerer, value.type) || typeReachesDyn(lowerer, value.type);
  const depthContext = reachesCustom && depth === Infinity && options.depthKind !== 1;
  const customContext = reachesCustom && !options.customInspect;
  if (depthContext || customContext) {
    const stmts: IrStmt[] = [];
    const restore: IrStmt[] = [];
    const setting = (fn: "insp.customInspect" | "insp.depthKind", arg: IrExpr, type: IrType) => {
      const previous = lowerer.declareHiddenLocal("%inspectContext", type);
      const call = (a: IrExpr): IrExpr => ({ kind: "libCall", fn, args: [a], type, loc });
      stmts.push({ kind: "varDecl", localId: previous.id, init: call(arg), loc });
      restore.push({ kind: "exprStmt", expr: call(varRef(previous.id, type, loc)), loc });
    };
    if (customContext) setting("insp.customInspect", boolLit(false, loc), BOOL);
    if (depthContext) setting("insp.depthKind", numLit(options.depthKind, loc), F64);
    const text = lowerer.declareHiddenLocal("%inspectText", STRING);
    stmts.push({
      kind: "varDecl",
      localId: text.id,
      init: withInspectLayout(
        lowerer,
        options,
        value,
        "inspect",
        (input) => inspectExpr(lowerer, value.type, input, numLit(0, loc), numLit(depth, loc), loc),
        loc,
      ),
      loc,
    });
    return {
      kind: "seqExpr",
      stmts: [...stmts, ...restore.reverse()],
      result: varRef(text.id, STRING, loc),
      type: STRING,
      loc,
    };
  }
  if (dir && value.type.kind === "dyn") {
    return withInspectLayout(
      lowerer,
      options,
      value,
      "dirDyn",
      (input) => ({
        kind: "libCall",
        fn: "console.dirDyn",
        args: [input, numLit(depth, loc)],
        type: STRING,
        loc,
      }),
      loc,
    );
  }
  return withInspectLayout(
    lowerer,
    options,
    value,
    "inspect",
    (input) => inspectExpr(lowerer, value.type, input, numLit(0, loc), numLit(depth, loc), loc),
    loc,
  );
}

/* ── util.format / util.formatWithOptions ────────────────────────────── */

/** One argument as format's %s conversion (Node: numbers via
 * formatNumber, strings verbatim, objects through inspect at the given
 * depth). Null = fence with the given reason. */
function formatSArg(lowerer: Lowerer, node: ts.Expression, depth: number, loc: SrcLoc): IrExpr {
  return formatSValue(lowerer, node, lowerer.lowerExpr(node), depth, loc);
}

/** formatSArg over the already-lowered value of `node`. */
function formatSValue(
  lowerer: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  depth: number,
  loc: SrcLoc,
): IrExpr {
  const t = value.type;
  if (t.kind === "string") return value;
  if (t.kind === "f64")
    return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
  if (t.kind === "bool") return { kind: "toString", operand: value, type: STRING, loc };
  if (t.kind === "undefinedT") return strLit("undefined", loc);
  if (t.kind === "nullT") return strLit("null", loc);
  // %s of a symbol prints inspect's text ("Symbol(foo)") — String(sym)'s
  // answer too, one runtime call either way.
  if (t.kind === "symbol")
    return { kind: "libCall", fn: "sym.toString", args: [value], type: STRING, loc };
  if (t.kind === "bigint")
    return { kind: "libCall", fn: "bigint.inspect", args: [value], type: STRING, loc };
  if (t.kind === "dyn") {
    return {
      kind: "libCall",
      fn: "insp.dynFormatS",
      args: [value, numLit(depth, loc)],
      type: STRING,
      loc,
    };
  }
  // A UNION argument dispatches per arm at runtime: a string arm prints
  // VERBATIM (typeof arg === 'string' in Node's formatter — inspect's
  // quoting never applies at the top level), every other arm inspects.
  if (t.kind === "union") {
    const walk = { recursive: false };
    const reason = inspectSupport(lowerer, t, new Set(), walk);
    if (reason !== null)
      lowerer.noLowering(`util.format %s of '${lowerer.fmt(t)}' values`, node, reason);
    return formatValueExpr(lowerer, t, value, depth, loc);
  }
  if (t.kind === "object" && !isErrorClass(lowerer, t.className)) {
    // hasBuiltInToString: a class with its OWN toString goes through
    // String(arg) in Node, not inspect — call it explicitly instead.
    for (
      let info: ClassInfo | null = lowerer.classes.get(t.className) ?? null;
      info;
      info = info.base
    ) {
      if (info.methods.has("toString")) {
        lowerer.noLowering(
          "util.format %s over a class with its own toString",
          node,
          "Node calls the override (String(arg)) — call it explicitly",
        );
      }
    }
  }
  if (t.kind === "bytes") {
    lowerer.noLowering(
      `util.format %s of typed-array values`,
      node,
      "pass util.inspect(buf) explicitly",
    );
  }
  const walk = { recursive: false };
  const reason = inspectSupport(lowerer, t, new Set(), walk);
  if (reason !== null)
    lowerer.noLowering(`util.format %s of '${lowerer.fmt(t)}' values`, node, reason);
  return inspectExpr(lowerer, t, value, numLit(0, loc), numLit(depth, loc), loc);
}

/** %O (depth 2) / %o (showHidden, depth 4) — inspect with the spec's
 * option deltas. A checked-dynamic argument renders through the runtime's
 * showHidden walk; static %o fences over arrays and nested dynamic values
 * (showHidden adds an array's hidden [length] entry, which the static
 * rendering has no lowering for). */
function formatOArg(lowerer: Lowerer, node: ts.Expression, depth: number, loc: SrcLoc): IrExpr {
  const value = lowerer.lowerExpr(node);
  if (depth === 4 && value.type.kind === "dyn") {
    return {
      kind: "libCall",
      fn: "insp.dynHidden",
      args: [value, numLit(4, loc)],
      type: STRING,
      loc,
    };
  }
  if (value.type.kind === "bytes") {
    lowerer.noLowering(
      `util.format %${depth === 4 ? "o" : "O"} of typed-array values`,
      node,
      "pass util.inspect(buf) explicitly",
    );
  }
  const walk = { recursive: false };
  const reason = inspectSupport(lowerer, value.type, new Set(), walk);
  if (reason !== null)
    lowerer.noLowering(
      `util.format %${depth === 4 ? "o" : "O"} of '${lowerer.fmt(value.type)}' values`,
      node,
      reason,
    );
  if (depth === 4 && typeReachesCustomInspect(lowerer, value.type)) {
    lowerer.noLowering(
      "util.format %o over values with [util.inspect.custom] methods",
      node,
      "%o passes showHidden to the methods — use %O",
    );
  }
  if (depth === 4 && typeTreeHasHidden(lowerer, value.type, new Set())) {
    lowerer.noLowering(
      "util.format %o over arrays",
      node,
      "%o renders with showHidden (arrays gain a hidden [length] entry) — use %O for the default rendering, or pass the value as unknown",
    );
  }
  return inspectExpr(lowerer, value.type, value, numLit(0, loc), numLit(depth, loc), loc);
}

/** %d and %i over a checked-dynamic argument, as Node's formatWithOptions
 * reads it: a bigint prints as `${n}n`, a symbol as NaN, and any other
 * value as `number` (Number(arg) for %d, parseInt(String(arg)) for %i)
 * formatted. The argument evaluates once. */
function formatDynInteger(
  lowerer: Lowerer,
  value: IrExpr,
  number: (held: IrExpr) => IrExpr,
  loc: SrcLoc,
): IrExpr {
  const held = lowerer.declareHiddenLocal("%formatArg", DYN);
  const ref = (): IrExpr => varRef(held.id, DYN, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "varDecl", localId: held.id, init: value, loc }],
    result: {
      kind: "ternary",
      cond: { kind: "dynTest", test: "bigint", value: ref(), type: BOOL, loc },
      then: {
        kind: "strConcat",
        left: { kind: "libCall", fn: "dyn.toStringCoerce", args: [ref()], type: STRING, loc },
        right: strLit("n", loc),
        type: STRING,
        loc,
      },
      else_: {
        kind: "ternary",
        cond: { kind: "dynTest", test: "symbol", value: ref(), type: BOOL, loc },
        then: strLit("NaN", loc),
        else_: { kind: "libCall", fn: "insp.f64", args: [number(ref())], type: STRING, loc },
        type: STRING,
        loc,
      },
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}

/** %d and %i over the argument types Node formats without a number
 * conversion: a bigint prints as `${n}n` (formatBigInt) and a symbol as NaN;
 * null is Number(null) (0) under %d and parseInt("null") (NaN) under %i, and
 * undefined (including a void call) is NaN under both. Other arguments
 * still evaluate. Null for other types. */
function formatIntegerFixed(value: IrExpr, spec: "%d" | "%i", loc: SrcLoc): IrExpr | null {
  if (value.type.kind === "bigint") {
    return { kind: "libCall", fn: "bigint.inspect", args: [value], type: STRING, loc };
  }
  let text: string;
  if (
    value.type.kind === "symbol" ||
    value.type.kind === "undefinedT" ||
    value.type.kind === "void"
  )
    text = "NaN";
  else if (value.type.kind === "nullT") text = spec === "%d" ? "0" : "NaN";
  else return null;
  if (value.kind === "unitLit") return strLit(text, loc);
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: value, loc }],
    result: strLit(text, loc),
    type: STRING,
    loc,
  };
}

/** util.format(...) / util.formatWithOptions({}, ...): the compile-time
 * %-substitution over a literal format string (formatWithOptionsInternal
 * ported exactly — the arg cursor, the args-exhausted guard, %c's
 * consume-and-drop), with per-static-type conversions. Format strings
 * known only at run time, spread arguments and non-empty options lower to
 * the runtime formatter (lowerRuntimeFormat, heldFormatArgs). */
export function lowerFormatCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
  withOptions: boolean,
  argNodesOverride?: readonly ts.Expression[],
  literalPrefix = "",
): IrExpr {
  const argNodes = [...(argNodesOverride ?? expr.arguments.nodes)];
  if (withOptions) {
    const opts = argNodes.shift();
    // The empty literal {} is the defaults: exactly util.format.
    if (!opts || !ts.isObjectLiteralExpression(opts) || opts.properties.nodes.length > 0) {
      if (opts && ts.isSpreadElement(opts)) {
        lowerer.noLowering(
          "util.formatWithOptions with a spread options argument",
          opts,
          "pass the options object as the first argument",
        );
      }
      return lowerRuntimeFormat(lowerer, argNodes, loc, opts ?? null);
    }
  }
  if (argNodes.length === 0) return strLit("", loc);
  const first = argNodes[0]!;
  const firstIsLiteral = ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first);
  if (argNodes.some(ts.isSpreadElement)) {
    if (literalPrefix !== "" && !firstIsLiteral)
      throw new InternalCompilerError("a format prefix needs a literal format string");
    return lowerRuntimeFormat(lowerer, argNodes, loc, undefined, literalPrefix);
  }

  /** The rest-args tail: ` ` + (strings verbatim, everything else
   * inspected at the default depth). */
  const restArg = (node: ts.Expression): IrExpr => formatSArg(lowerer, node, 2, loc);

  if (!firstIsLiteral) {
    const runtime = argNodes.length > 1 ? runtimeFormatString(lowerer, first) : null;
    if (runtime === "other" && !formatStringConverts(lowerer, first))
      return lowerRuntimeFormat(lowerer, argNodes, loc);
    if (runtime !== null) {
      // A string that substitutes formats at run time; any other string
      // joins with the remaining arguments, as below.
      const held = heldFormatArgs(lowerer, argNodes, loc);
      if (!held.joinable) {
        return { kind: "seqExpr", stmts: held.stmts, result: held.format(), type: STRING, loc };
      }
      const joined: IrExpr[] = [];
      held.args.forEach((arg, i) => {
        if (i > 0) joined.push(strLit(" ", loc));
        joined.push(formatRestValue(lowerer, arg.node, arg.ref(), loc));
      });
      return {
        kind: "seqExpr",
        stmts: held.stmts,
        result: {
          kind: "ternary",
          cond: held.specifies,
          then: held.format(),
          else_: concatAll(joined, loc),
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      };
    }
    // No substitutions possible: every argument joins with spaces.
    const parts: IrExpr[] = [];
    for (let i = 0; i < argNodes.length; i++) {
      if (i > 0) parts.push(strLit(" ", loc));
      parts.push(restArg(argNodes[i]!));
    }
    return concatAll(parts, loc);
  }

  // A literal prefix joins the format text (console.assert's "Assertion
  // failed: " — Node formats the joined string).
  const fmt = literalPrefix + (first as ts.StringLiteralLike).text;
  // Node's early return: a lone string first argument passes VERBATIM —
  // no substitution runs, "%%" stays "%%".
  if (argNodes.length === 1) return strLit(fmt, loc);
  const parts: IrExpr[] = [];
  let a = 0; // the arg cursor over argNodes (0 = the format string)
  let lastPos = 0;
  const args = argNodes;
  const convert = (spec: number, node: ts.Expression): IrExpr => {
    switch (spec) {
      case 115: // %s
        return formatSArg(lowerer, node, 0, loc);
      case 100: {
        // %d — Number(arg) formatted: numbers as-is, booleans 1/0,
        // strings through the runtime's ECMA-exact StringToNumber
        // (num.fromString — the same lowering Number(aString) takes).
        const value = lowerer.lowerExpr(node);
        const fixed = formatIntegerFixed(value, "%d", loc);
        if (fixed) return fixed;
        if (value.type.kind === "f64")
          return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
        if (value.type.kind === "string") {
          const parsed: IrExpr = {
            kind: "libCall",
            fn: "num.fromString",
            args: [value],
            type: F64,
            loc,
          };
          return { kind: "libCall", fn: "insp.f64", args: [parsed], type: STRING, loc };
        }
        if (value.type.kind === "bool") {
          return {
            kind: "libCall",
            fn: "insp.f64",
            args: [
              {
                kind: "ternary",
                cond: value,
                then: numLit(1, loc),
                else_: numLit(0, loc),
                type: F64,
                loc,
              },
            ],
            type: STRING,
            loc,
          };
        }
        // A checked-dynamic argument (`console.log('... actual %d.',
        // context.actual)` — test/common's exit report): Number(arg).
        if (value.type.kind === "dyn") {
          return formatDynInteger(
            lowerer,
            value,
            (held) => ({
              kind: "libCall",
              fn: "dyn.numberConstructor",
              args: [held],
              type: F64,
              loc,
            }),
            loc,
          );
        }
        lowerer.noLowering(
          `util.format %d of '${lowerer.fmt(value.type)}' values`,
          node,
          "numbers, booleans, and strings lower; ToNumber over other types has no static lowering",
        );
        break;
      }
      case 105: {
        // %i — parseInt(ToString(arg)): the spec-exact composition.
        const value = lowerer.lowerExpr(node);
        const fixed = formatIntegerFixed(value, "%i", loc);
        if (fixed) return fixed;
        if (
          value.type.kind === "f64" ||
          value.type.kind === "bool" ||
          value.type.kind === "string"
        ) {
          const text: IrExpr =
            value.type.kind === "string"
              ? value
              : { kind: "toString", operand: value, type: STRING, loc };
          const parsed: IrExpr = {
            kind: "libCall",
            fn: "num.parseInt",
            args: [text, numLit(0, loc)],
            type: F64,
            loc,
          };
          return { kind: "libCall", fn: "insp.f64", args: [parsed], type: STRING, loc };
        }
        // parseInt(String(arg)) over a checked-dynamic argument.
        if (value.type.kind === "dyn") {
          return formatDynInteger(
            lowerer,
            value,
            (held) => ({
              kind: "libCall",
              fn: "num.parseInt",
              args: [
                { kind: "libCall", fn: "dyn.toStringCoerce", args: [held], type: STRING, loc },
                numLit(0, loc),
              ],
              type: F64,
              loc,
            }),
            loc,
          );
        }
        lowerer.noLowering(`util.format %i of '${lowerer.fmt(value.type)}' values`, node);
        break;
      }
      case 106: {
        // %j — JSON.stringify; undefined-valued args print "undefined"
        // (Node appends the non-string result of tryStringify).
        const value = lowerer.lowerExpr(node);
        if (value.type.kind === "undefinedT") return strLit("undefined", loc);
        // JSON.stringify(sym) is undefined in Node — %j prints the
        // "undefined" text. Folding drops the operand, so only
        // side-effect-free reads compose (the typeof-fold stance).
        if (value.type.kind === "symbol") {
          if (!isSafeToRepeat(value)) {
            lowerer.noLowering(
              `util.format %j of computed symbol values`,
              node,
              'bind the symbol to a const first (the %j text is always "undefined")',
            );
          }
          return strLit("undefined", loc);
        }
        // A checked-dynamic argument (`console.error('headers: %j',
        // headers)` — the suite's http logging idiom): the runtime runs
        // JSON.stringify's walk (toJSON hooks included; a root it drops
        // prints "undefined") and prints "[Circular]" for a circular
        // structure. A typed argument prints "[Circular]" the same way.
        if (value.type.kind === "dyn") {
          return { kind: "libCall", fn: "insp.jsonDyn", args: [value], type: STRING, loc };
        }
        if (!lowerer.jsonStringifySafe(value.type)) {
          lowerer.noLowering(
            `util.format %j of '${lowerer.fmt(value.type)}' values`,
            node,
            "only JSON-safe static types lower",
          );
        }
        return { kind: "jsonStringify", value, circular: true, type: STRING, loc };
      }
      case 102: {
        // %f — parseFloat(String(arg)) formatted: a number keeps its value
        // except -0, which String() prints as "0"; strings parse with the
        // global parseFloat; booleans and unit values (void calls and
        // null | undefined unions included) parse to NaN.
        const value = lowerer.lowerExpr(node);
        const format = (number: IrExpr): IrExpr => ({
          kind: "libCall",
          fn: "insp.f64",
          args: [number],
          type: STRING,
          loc,
        });
        const parse = (text: IrExpr): IrExpr =>
          format({ kind: "libCall", fn: "num.parseFloat", args: [text], type: F64, loc });
        if (value.type.kind === "f64")
          return format({
            kind: "bin",
            op: "+",
            left: value,
            right: numLit(0, loc),
            type: F64,
            loc,
          });
        if (value.type.kind === "string") return parse(value);
        if (value.type.kind === "dyn") {
          return parse({
            kind: "libCall",
            fn: "dyn.toStringCoerce",
            args: [value],
            type: STRING,
            loc,
          });
        }
        const unitArms = (t: IrType): boolean =>
          t.kind === "union" && (lowerer.unions.get(t.unionId)?.arms.every(isUnitType) ?? false);
        if (
          value.type.kind === "bool" ||
          value.type.kind === "void" ||
          isUnitType(value.type) ||
          unitArms(value.type)
        ) {
          // The argument still evaluates once, for its effects: the value
          // already lowered, as a statement (never a second lowering of the
          // node, whose lifted helpers and closures would be built twice).
          if (isSafeToDiscard(value)) return strLit("NaN", loc);
          return {
            kind: "seqExpr",
            stmts: [{ kind: "exprStmt", expr: value, loc }],
            result: strLit("NaN", loc),
            type: STRING,
            loc,
          };
        }
        lowerer.noLowering(
          `util.format %f of '${lowerer.fmt(value.type)}' values`,
          node,
          "pass a number, string or boolean, or convert the argument with String() first",
        );
        return strLit("NaN", loc);
      }
      case 79: // %O — inspect at the defaults
        return formatOArg(lowerer, node, 2, loc);
      case 111: // %o — showHidden semantics; depth 4
        return formatOArg(lowerer, node, 4, loc);
    }
    throw new InternalCompilerError("unreachable format spec");
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
          case 102: // f
          case 105: {
            // i
            const node = args[++a]!;
            if (lastPos !== i - 1) parts.push(strLit(fmt.slice(lastPos, i - 1), loc));
            parts.push(convert(nextChar, node));
            lastPos = i + 1;
            continue;
          }
          case 99: // c — consumes its argument, contributes nothing
            a += 1;
            if (lastPos !== i - 1) parts.push(strLit(fmt.slice(lastPos, i - 1), loc));
            lastPos = i + 1;
            continue;
          case 37: // %%
            parts.push(strLit(fmt.slice(lastPos, i), loc));
            lastPos = i + 1;
            continue;
          default:
            continue;
        }
      } else if (nextChar === 37) {
        parts.push(strLit(fmt.slice(lastPos, i), loc));
        lastPos = i + 1;
      }
    }
  }
  if (lastPos !== 0) {
    a++;
    if (lastPos < fmt.length) parts.push(strLit(fmt.slice(lastPos), loc));
  } else {
    // No substitution touched the format string: it joins verbatim, and
    // the cursor advances past it.
    parts.push(strLit(fmt, loc));
    a++;
  }
  for (; a < args.length; a++) {
    parts.push(strLit(" ", loc));
    parts.push(restArg(args[a]!));
  }
  return concatAll(parts, loc);
}

/** One space-joined argument of util.format, as Node's formatter renders
 * it after the format string: strings verbatim, everything else through
 * inspect at the default depth. */
function formatRestValue(
  lowerer: Lowerer,
  node: ts.Expression,
  value: IrExpr,
  loc: SrcLoc,
): IrExpr {
  switch (value.type.kind) {
    case "string":
      return value;
    case "f64":
      return { kind: "libCall", fn: "insp.f64", args: [value], type: STRING, loc };
    case "bool":
      return { kind: "toString", operand: value, type: STRING, loc };
    case "dyn":
      return { kind: "libCall", fn: "insp.dynS", args: [value, numLit(2, loc)], type: STRING, loc };
    default:
      return lowerConsoleInspectArg(lowerer, node, value, "util.format", loc);
  }
}

const UNCONVERTIBLE_HINT =
  "the runtime formatter reads its arguments as checked-dynamic values — use a string literal format";

/** A string-valued expression that throws the SC2020 refusal where it runs
 * (a JavaScript construct fence deferred to the branch that needs it). */
function runtimeFenceValue(
  lowerer: Lowerer,
  surface: string,
  node: ts.Node,
  hint: string,
  loc: SrcLoc,
): IrExpr {
  const diag = noLoweringDiag(surface, locOf(node), hint);
  lowerer.runtimeFences.push(diag);
  const sf = ts.getSourceFileOfNode(node);
  const line = ts.getLineAndCharacterOfPosition(sf, diag.loc.start).line + 1;
  const slot = lowerer.declareHiddenLocal("%never", STRING);
  slot.mutable = true;
  return {
    kind: "seqExpr",
    stmts: [
      { kind: "varDecl", localId: slot.id, init: null, loc },
      {
        kind: "runtimeFence",
        code: diag.code,
        message: `${diag.message} [${diag.code} at ${diag.loc.file}:${line}]`,
        loc,
      },
    ],
    result: varRef(slot.id, STRING, loc),
    diverges: true,
    type: STRING,
    loc,
  };
}

/** Whether the held-argument form can test a format string whose type
 * only may hold a string: a union that converts to a checked-dynamic value,
 * or a value whose checker type does not map (its lowered type decides). */
export function formatStringConverts(lowerer: Lowerer, first: ts.Expression): boolean {
  const t = lowerer.mapTypeOf(lowerer.typeOf(first));
  return t === null || t.kind === "dyn" || lowerer.dynConvertible(t);
}

/** How a non-literal format string is known: "string" and "dyn" values
 * test for a substitution at run time, "other" types (unions with a string
 * arm) format at run time, and null types never hold a string. */
export function runtimeFormatString(
  lowerer: Lowerer,
  first: ts.Expression,
): "string" | "dyn" | "other" | null {
  const t = lowerer.mapTypeOf(lowerer.typeOf(first));
  if (t === null) return "other";
  if (t.kind === "string") return "string";
  if (t.kind === "dyn") return "dyn";
  if (t.kind === "union") {
    const arms = lowerer.unions.get(t.unionId)?.arms ?? [];
    return arms.some((arm) => arm.kind === "string" || arm.kind === "dyn") ? "other" : null;
  }
  return t.kind === "jsval" || t.kind === "caught" ? "other" : null;
}

/** The runtime formatter over a call's arguments: one checked-dynamic
 * pack in source order (spreads contribute their elements), after the
 * options when `options` is given (null: an omitted options argument,
 * which Node's validation rejects). A literal prefix joins a literal
 * format string. */
export function lowerRuntimeFormat(
  lowerer: Lowerer,
  argNodes: readonly ts.Expression[],
  loc: SrcLoc,
  options?: ts.Expression | null,
  literalPrefix = "",
): IrExpr {
  const stmts: IrStmt[] = [];
  let optionsRef: IrExpr | null = null;
  if (options !== undefined) {
    const held = lowerer.declareHiddenLocal("%formatOptions", DYN);
    stmts.push({
      kind: "varDecl",
      localId: held.id,
      init: options === null ? dynUndefinedExpr(loc) : lowerer.lowerExprExpecting(options, DYN),
      loc,
    });
    optionsRef = varRef(held.id, DYN, loc);
  }
  let nodes = argNodes;
  const leading: IrExpr[] = [];
  if (literalPrefix !== "") {
    const first = argNodes[0] as ts.StringLiteralLike;
    leading.push(strLit(literalPrefix + first.text, loc));
    nodes = argNodes.slice(1);
  }
  const pack = dynArgumentPack(lowerer, nodes, loc, {
    leading,
    blame: argNodes[0] ?? options ?? undefined,
  });
  stmts.push(...pack.stmts);
  const result: IrExpr =
    optionsRef === null
      ? { kind: "libCall", fn: "insp.format", args: [pack.pack()], type: STRING, loc }
      : {
          kind: "libCall",
          fn: "insp.formatWithOptions",
          args: [optionsRef, pack.pack()],
          type: STRING,
          loc,
        };
  return { kind: "seqExpr", stmts, result, type: STRING, loc };
}

/** The arguments of a call whose first argument is a string or dyn value
 * known only at run time, each evaluated once into a hidden local:
 * `specifies` tests that string for a '%' before its last character, and
 * `format()` is the runtime formatter over the held values. The caller
 * renders the other branch (the space-joined arguments) from `args` when
 * every argument is `joinable` there. */
export function heldFormatArgs(
  lowerer: Lowerer,
  argNodes: readonly ts.Expression[],
  loc: SrcLoc,
): {
  stmts: IrStmt[];
  args: { node: ts.Expression; ref: () => IrExpr }[];
  specifies: IrExpr;
  format: () => IrExpr;
  joinable: boolean;
} {
  const stmts: IrStmt[] = [];
  let unconvertible: { node: ts.Expression; type: IrType } | null = null;
  const unconvertibleSurface = (t: IrType): string =>
    `util.format with a runtime format string over '${lowerer.fmt(t)}' values`;
  const args = argNodes.map((node) => {
    const value = lowerer.lowerExpr(node);
    if (value.type.kind === "void") {
      lowerer.unsupported(
        "SC1090",
        node,
        "util.format of a void call result (call it as its own statement, then pass undefined)",
      );
    }
    // The space-joined branch prints these values as before; only a string
    // that substitutes refuses them, where it runs.
    if (value.type.kind !== "dyn" && !lowerer.dynConvertible(value.type))
      unconvertible ??= { node, type: value.type };
    // Unit values have no local: their effects run here and a literal
    // stands in.
    const k = value.type.kind;
    if (k === "undefinedT" || k === "nullT") {
      if (value.kind !== "unitLit") stmts.push({ kind: "exprStmt", expr: value, loc });
      const unit = k === "nullT" ? ("null" as const) : ("undefined" as const);
      return { node, ref: (): IrExpr => ({ kind: "unitLit", unit, type: value.type, loc }) };
    }
    const held = lowerer.declareHiddenLocal("%formatArg", value.type);
    stmts.push({ kind: "varDecl", localId: held.id, init: value, loc });
    return { node, ref: () => varRef(held.id, value.type, loc) };
  });
  const first = args[0]!.ref();
  // A lowered value that is neither a string nor convertible holds no
  // string, so it never substitutes.
  const specifies: IrExpr =
    first.type.kind === "string"
      ? { kind: "libCall", fn: "insp.formatSpecifies", args: [first], type: BOOL, loc }
      : first.type.kind === "dyn" || lowerer.dynConvertible(first.type)
        ? {
            kind: "libCall",
            fn: "insp.formatSpecifiesDyn",
            args: [lowerer.coerceToExpected(first, DYN)],
            type: BOOL,
            loc,
          }
        : { kind: "boolLit", value: false, type: BOOL, loc };
  const format = (): IrExpr => {
    if (unconvertible !== null) {
      const fenced = unconvertible;
      return runtimeFenceValue(
        lowerer,
        unconvertibleSurface(fenced.type),
        fenced.node,
        UNCONVERTIBLE_HINT,
        loc,
      );
    }
    // Strings, numbers, booleans, null and undefined format without the
    // checked-dynamic walk other values need, which keeps it out of the
    // executable.
    const primitive = (t: IrType): boolean =>
      t.kind === "string" ||
      t.kind === "f64" ||
      t.kind === "bool" ||
      t.kind === "undefinedT" ||
      t.kind === "nullT" ||
      (t.kind === "union" && (lowerer.unions.get(t.unionId)?.arms.every(primitive) ?? false));
    // A native list of the checked values: converting into it is a tier
    // boundary, so the statement stays static.
    return {
      kind: "libCall",
      fn: args.every((arg) => primitive(arg.ref().type))
        ? "insp.formatPrimitives"
        : "insp.formatList",
      args: [
        {
          kind: "arrayLit",
          elems: args.map((arg) => lowerer.coerceToExpected(arg.ref(), DYN)),
          type: arrayOf(DYN),
          loc,
        },
      ],
      type: STRING,
      loc,
    };
  };
  // The space-joined branch renders each argument statically; arguments
  // the static rendering refuses take the runtime formatter in both cases.
  const joinable = args.every(({ ref }) => {
    const t = ref().type;
    if (t.kind === "func") return false;
    if (t.kind === "bytes") return true;
    return inspectSupport(lowerer, t, new Set(), { recursive: false }) === null;
  });
  // Without a joined branch every call formats: TypeScript refuses the
  // value at compile time.
  const refused = unconvertible as { node: ts.Expression; type: IrType } | null;
  if (!joinable && refused !== null && !isJsSourceFile(ts.getSourceFileOfNode(refused.node)))
    lowerer.noLowering(unconvertibleSurface(refused.type), refused.node, UNCONVERTIBLE_HINT);
  return { stmts, args, specifies, format, joinable };
}

/** Arrays anywhere in the tree — the %o (showHidden) gate. */
function typeTreeHasHidden(lowerer: Lowerer, t: IrType, visiting: Set<string>): boolean {
  switch (t.kind) {
    case "array":
    case "dyn":
      return true;
    case "record": {
      if (visiting.has(t.shapeId)) return false;
      visiting.add(t.shapeId);
      const shape = lowerer.shapes.get(t.shapeId);
      if (shape?.tuple) return true;
      return (shape?.fields ?? []).some((f) => typeTreeHasHidden(lowerer, f.type, visiting));
    }
    case "map":
      return (
        typeTreeHasHidden(lowerer, t.key, visiting) || typeTreeHasHidden(lowerer, t.value, visiting)
      );
    case "set":
      return typeTreeHasHidden(lowerer, t.elem, visiting);
    case "union": {
      if (visiting.has(t.unionId)) return false;
      visiting.add(t.unionId);
      return (lowerer.unions.get(t.unionId)?.arms ?? []).some((a) =>
        typeTreeHasHidden(lowerer, a, visiting),
      );
    }
    case "object": {
      if (visiting.has(t.className)) return false;
      visiting.add(t.className);
      return (lowerer.classes.get(t.className)?.def.fields ?? []).some((f) =>
        typeTreeHasHidden(lowerer, f.type, visiting),
      );
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
  lowerer: Lowerer,
  expr: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module !== "util") return null;
  switch (bi.member) {
    case "styleText":
    case "isDeepStrictEqual": {
      if (expr.arguments.nodes.some(ts.isSpreadElement))
        lowerer.noLowering(`util.${bi.member} with spread arguments`, expr);
      const stmts: IrStmt[] = [];
      const args: IrExpr[] = [];
      // Save all inputs before evaluating surplus arguments: comparison may
      // read mutable objects or throw, so it must happen after every argument.
      for (let i = 0; i < 3; i++) {
        const input: IrExpr = expr.arguments.nodes[i]
          ? lowerer.lowerExprExpecting(expr.arguments.nodes[i]!, DYN)
          : dynUndefinedExpr(loc);
        const saved = lowerer.declareHiddenLocal("%utilInput", DYN);
        stmts.push({ kind: "varDecl", localId: saved.id, init: input, loc });
        args.push(varRef(saved.id, DYN, loc));
      }
      for (const arg of expr.arguments.nodes.slice(3))
        stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc });
      const type = bi.member === "styleText" ? STRING : BOOL;
      return {
        kind: "seqExpr",
        stmts,
        result: { kind: "libCall", fn: `util.${bi.member}`, args, type, loc },
        type,
        loc,
      };
    }
    case "inherits":
    case "deprecate":
    case "callbackify":
    case "debuglog":
    case "debug":
      return lowerUtilCallableCall(lowerer, expr, bi.member, loc);
    case "getSystemErrorMap": {
      if (expr.arguments.nodes.some(ts.isSpreadElement))
        lowerer.noLowering("util.getSystemErrorMap with spread arguments", expr);
      const result = lowerSystemErrorMap(lowerer, loc);
      const stmts: IrStmt[] = expr.arguments.nodes.map((arg) => ({
        kind: "exprStmt",
        expr: lowerer.lowerExpr(arg),
        loc,
      }));
      return stmts.length ? { kind: "seqExpr", stmts, result, type: result.type, loc } : result;
    }
    case "getSystemErrorName":
    case "getSystemErrorMessage":
    case "stripVTControlCharacters":
    case "toUSVString": {
      if (expr.arguments.nodes.some(ts.isSpreadElement))
        lowerer.noLowering(`util.${bi.member} with spread arguments`, expr);
      const input = expr.arguments.nodes[0]
        ? lowerer.lowerExprExpecting(expr.arguments.nodes[0], DYN)
        : {
            kind: "dynFrom" as const,
            value: { kind: "unitLit" as const, unit: "undefined" as const, type: UNDEFINED_T, loc },
            type: DYN,
            loc,
          };
      if (expr.arguments.nodes.length <= 1)
        return { kind: "libCall", fn: `util.${bi.member}`, args: [input], type: STRING, loc };
      const saved = lowerer.declareHiddenLocal("%utilInput", DYN);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: saved.id, init: input, loc },
          ...expr.arguments.nodes
            .slice(1)
            .map((arg): IrStmt => ({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc })),
        ],
        result: {
          kind: "libCall",
          fn: `util.${bi.member}`,
          args: [varRef(saved.id, DYN, loc)],
          type: STRING,
          loc,
        },
        type: STRING,
        loc,
      };
    }
    case "inspect":
      return lowerInspectCall(lowerer, expr, loc);
    case "format":
      return lowerFormatCall(lowerer, expr, loc, false);
    case "formatWithOptions":
      return lowerFormatCall(lowerer, expr, loc, true);
    case "parseArgs":
      return lowerParseArgsCall(lowerer, expr, loc);
    case "parseEnv": {
      if (expr.arguments.nodes.length > 1 || expr.arguments.nodes.some(ts.isSpreadElement)) {
        lowerer.noLowering("util.parseEnv with spread or extra arguments", expr);
      }
      const input: IrExpr = expr.arguments.nodes[0]
        ? lowerer.lowerExprExpecting(expr.arguments.nodes[0], DYN)
        : dynUndefinedExpr(loc);
      const parsed: IrExpr = {
        kind: "libCall",
        fn: "util.parseEnv",
        args: [input],
        type: DYN,
        loc,
      };
      const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
      if (
        result &&
        result.kind !== "dyn" &&
        canDynCheckTo(
          result,
          (id) => lowerer.shapes.get(id),
          (id) => lowerer.unions.get(id),
        )
      ) {
        return { kind: "dynCheck", value: parsed, type: result, loc };
      }
      return parsed;
    }
    case "getCallSites":
      return lowerGetCallSitesCall(lowerer, expr, loc);
    default:
      return null;
  }
}

/** util.inherits/deprecate/callbackify/debuglog: every argument crosses as
 * a checked-dynamic value, evaluated left to right before the runtime call
 * (surplus arguments are evaluated and dropped). The function helpers
 * answer native dyn wrappers; a static function slot checks the wrapper
 * when it receives it, and dyn slots keep calling it with JS arity. */
function lowerUtilCallableCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  member: string,
  loc: SrcLoc,
): IrExpr {
  if (expr.arguments.nodes.some(ts.isSpreadElement))
    lowerer.noLowering(`util.${member} with spread arguments`, expr);
  const fn =
    member === "inherits"
      ? "util.inherits"
      : member === "deprecate"
        ? "util.deprecate"
        : member === "callbackify"
          ? "util.callbackify"
          : "util.debuglog";
  const arity = member === "deprecate" ? 4 : member === "callbackify" ? 1 : 2;
  // Program classes keep static prototypes: there is no function object
  // whose prototype chain the runtime could relink or wrap.
  // EventEmitter and the stream classes are the exception as superCtor:
  // the runtime has untyped constructors for them (builtin-class-dyn.ts).
  const classArgs = member === "inherits" ? 2 : member === "deprecate" ? 1 : 0;
  const builtinBase =
    member === "inherits" && expr.arguments.nodes[1] !== undefined
      ? builtinClassKindOf(lowerer, expr.arguments.nodes[1])
      : null;
  // A superCtor class whose prototype has a complete view (a module-level
  // JavaScript class named directly) passes that view to the runtime.
  const superView =
    member === "inherits" && builtinBase === null && expr.arguments.nodes[1] !== undefined
      ? classPrototypeView(lowerer, expr.arguments.nodes[1], loc)
      : null;
  for (const [index, arg] of expr.arguments.nodes.slice(0, classArgs).entries()) {
    if (index === 1 && (builtinBase !== null || superView !== null)) continue;
    if (lowerer.mapTypeOf(lowerer.typeOf(arg))?.kind === "classval")
      lowerer.noLowering(
        `util.${member} over a class constructor`,
        arg,
        member === "inherits"
          ? "declare the subclass with extends"
          : "deprecate a factory function or the class's call sites instead",
      );
  }
  if (member === "callbackify" && callbackifyErrorExcludesNull(lowerer, expr))
    lowerer.noLowering(
      "util.callbackify into a callback whose error parameter excludes null",
      expr,
      "Node calls back with a null error on success; type the binding's callback as (err: NodeJS.ErrnoException | null, ...) => void",
    );
  const stmts: IrStmt[] = [];
  const args: IrExpr[] = [];
  for (let i = 0; i < arity; i++) {
    const node = expr.arguments.nodes[i];
    const input: IrExpr = !node
      ? dynUndefinedExpr(loc)
      : i === 1 && builtinBase !== null
        ? (builtinClassDynValueOf(lowerer, node) ?? lowerer.lowerExprExpecting(node, DYN))
        : lowerer.lowerExprExpecting(node, DYN);
    const saved = lowerer.declareHiddenLocal("%utilInput", DYN);
    stmts.push({ kind: "varDecl", localId: saved.id, init: input, loc });
    args.push(varRef(saved.id, DYN, loc));
  }
  for (const arg of expr.arguments.nodes.slice(arity))
    stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(arg), loc });
  const type = fn === "util.inherits" ? VOID : DYN;
  const result: IrExpr = superView
    ? { kind: "libCall", fn: "util.inheritsPrototype", args: [...args, superView], type, loc }
    : { kind: "libCall", fn, args, type, loc };
  return { kind: "seqExpr", stmts, result, type: result.type, loc };
}

/** Whether the slot receiving a callbackify wrapper declares a callback
 * whose first parameter cannot hold null. Some @types/node overloads type
 * that error as NodeJS.ErrnoException, but Node passes null on success, and
 * a statically typed callback parameter cannot receive a value its type
 * excludes. Untyped (JavaScript or unknown) slots keep the wrapper dyn. */
function callbackifyErrorExcludesNull(lowerer: Lowerer, expr: ts.CallExpression): boolean {
  if (isJsSourceFile(ts.getSourceFileOfNode(expr))) return false;
  const checker = lowerer.checker;
  const slot = checker.getContextualType(expr) ?? lowerer.typeOf(expr);
  const wrapper = checker.getCallSignatures(slot)[0];
  const callbackSymbol = wrapper?.getParameters().at(-1);
  if (!callbackSymbol) return false;
  const callback = checker.getCallSignatures(checker.getTypeOfSymbol(callbackSymbol))[0];
  const errorSymbol = callback?.getParameters()[0];
  if (!errorSymbol) return false;
  const error = checker.getTypeOfSymbol(errorSymbol);
  const arms = error.isUnionType() ? ts.constituentTypes(error) : [error];
  return !arms.some(
    (arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0,
  );
}

/** util.parseArgs(config?): the configuration is ordinary JSON-safe data,
 * so it crosses into the runtime as a checked-dynamic tree. The native
 * parser returns the same tree-shaped result Node does (including token
 * variants and a null-prototype values object); statically typed member
 * reads leave that tree through the ordinary dyn checks. */
function lowerParseArgsCall(lowerer: Lowerer, expr: ts.CallExpression, loc: SrcLoc): IrExpr {
  if (expr.arguments.nodes.length > 1 || expr.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(
      `util.parseArgs with ${expr.arguments.nodes.length} arguments`,
      expr,
      "the lowered form is parseArgs() or parseArgs(config)",
    );
  }

  let config: IrExpr;
  const configNode = expr.arguments.nodes[0];
  if (!configNode) {
    config = { kind: "dynObjLit", fields: [], type: DYN, loc };
  } else {
    const raw = lowerer.lowerExpr(configNode);
    if (raw.type.kind === "dyn") {
      config = raw;
    } else if (
      canConvertToDyn(
        raw.type,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      // parseArgs assigns descriptor default arrays directly into the
      // returned values object. Keep mutable config composites in typed-ref
      // capsules so that default arrays can leave the dyn result as the
      // original static reference; the runtime still snapshots `args` and
      // the option schema before parsing, matching Node's synchronous read.
      const liveRef =
        raw.type.kind === "record" || raw.type.kind === "array" || raw.type.kind === "bytes";
      config = {
        kind: "dynFrom",
        value: raw,
        ...(liveRef ? { liveRef: true as const } : {}),
        type: DYN,
        loc,
      };
    } else {
      lowerer.noLowering(
        `util.parseArgs with a '${lowerer.fmt(raw.type)}' configuration`,
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
  const result = lowerer.mapTypeOf(lowerer.typeOf(expr));
  if (
    result !== null &&
    result.kind !== "dyn" &&
    result.kind !== "void" &&
    canDynCheckTo(
      result,
      (id) => lowerer.shapes.get(id),
      (id) => lowerer.unions.get(id),
    )
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
 * real frames must fail at compile time instead of reading placeholders. */
function lowerGetCallSitesCall(
  lowerer: Lowerer,
  expr: ts.CallExpression,
  loc: SrcLoc,
): IrExpr | null {
  if (expr.arguments.nodes.length !== 0) return null;
  if (!isJsSourceFile(ts.getSourceFileOfNode(expr))) return null;
  const frame = (): IrExpr => {
    const field = (name: string, value: IrExpr): { key: IrExpr; value: IrExpr } => ({
      key: { kind: "strLit", value: name, type: STRING, loc },
      value: { kind: "dynFrom", value, type: DYN, loc },
    });
    return {
      kind: "dynObjLit",
      fields: [
        field("functionName", { kind: "strLit", value: "", type: STRING, loc }),
        field("scriptName", {
          kind: "strLit",
          value: ts.getSourceFileOfNode(expr).fileName,
          type: STRING,
          loc,
        }),
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
