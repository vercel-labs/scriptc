import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { canonicalBuiltinModule, isJsSourceFile, locOf, requireSpecOf } from "../../program.js";
import { builtinConstLit } from "../surfaces.js";
import { HTTP2_CONSTANTS } from "../http2-constants.js";
import { CRYPTO_CONSTANTS } from "../crypto-tables.js";
import { ZLIB_CONSTANTS } from "../zlib-constants.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrStmt,
  type IrType,
  STRING,
  type SrcLoc,
} from "../../../ir/ir.js";
import { varRef } from "../../../ir/build.js";
import { InternalCompilerError } from "../../../errors.js";
import { keyedHelperName } from "../stable-names.js";
import { builtinImportOf } from "./module-bindings.js";

/** The builtin modules whose `constants` object bakes as literals at
 * every access site (the fs.constants precedent, scaled up): http2's
 * full Node v24 table, crypto's OpenSSL-constant table, zlib's table,
 * and buffer's MAX_LENGTH. The members never materialize, but the object
 * itself does where a program reads it whole: cryptoConstantsValue and
 * zlibConstantsValue build each module's singleton from its table. */
const BUILTIN_CONSTANTS_TABLES: Record<
  string,
  { table: Record<string, number | string>; hint: string } | undefined
> = {
  http2: {
    table: HTTP2_CONSTANTS,
    hint: "the table bakes Node v24's 240 members as literals — this name is not one of them",
  },
  crypto: {
    table: CRYPTO_CONSTANTS,
    hint: "the table bakes Node v24's crypto.constants members as literals — this name is not one of them",
  },
  buffer: {
    table: { MAX_LENGTH: 9007199254740991, MAX_STRING_LENGTH: 536870888 },
    hint: "the table bakes Node v24's buffer.constants members as literals — this name is not one of them",
  },
  zlib: {
    table: ZLIB_CONSTANTS,
    hint: "the table bakes Node v24's zlib.constants members as literals — this name is not one of them",
  },
};

/** The module whose baked-constants OBJECT `node` denotes, or null — any
 * of the spellings: `http2.constants`/`crypto.constants` through a
 * namespace/require binding, a destructured or member-bound `constants`
 * alias from the module, or `require("http2").constants` inline. The
 * object itself never materializes; each member read bakes as its
 * literal. */
function builtinConstantsModuleOf(lowerer: Lowerer, node: ts.Expression): string | null {
  let module: string | null = null;
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    if (node.name.text !== "constants") return null;
    const bi = lowerer.builtinMemberOf(node);
    if (bi) module = bi.module;
    else {
      const spec = requireSpecOf(node.expression);
      module = spec !== null ? canonicalBuiltinModule(spec) : null;
    }
  } else if (ts.isIdentifier(node)) {
    const bi = builtinImportOf(lowerer, node);
    if (bi !== null && bi.member === "constants") module = bi.module;
  }
  return module !== null && own(BUILTIN_CONSTANTS_TABLES, module) !== undefined ? module : null;
}

/** `constants.NGHTTP2_CANCEL` / `constants.SSL_OP_NO_TICKET` (any baked-
 * constants spelling) → the literal; unknown members fence by name.
 * Null when the receiver is not a baked constants object (the property
 * chain keeps trying). */
export function lowerBuiltinConstantsProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const module = builtinConstantsModuleOf(lowerer, expr.expression);
  if (module === null) return null;
  const entry = BUILTIN_CONSTANTS_TABLES[module]!;
  const value = own(entry.table, expr.name.text);
  if (value === undefined) {
    lowerer.noLowering(`${module}.constants.${expr.name.text}`, expr, entry.hint);
  }
  return builtinConstLit(value, locOf(expr));
}

/** True for `const { NGHTTP2_CANCEL, ... } = http2.constants` (and the
 * crypto.constants twin) — a plain object destructure (identifier
 * elements, renames allowed, no rest/defaults/nesting) over a baked
 * constants object whose every name is in its table. The declaration is
 * alias plumbing with no storage (lowerVarDecl and collectGlobals both
 * skip it); each USE reads its baked literal
 * (builtinConstantBindingOf). */
export function builtinConstantsDestructureDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isObjectBindingPattern(nameNode) || !init) return false;
  const module = builtinConstantsModuleOf(lowerer, init);
  if (module === null) return false;
  const table = BUILTIN_CONSTANTS_TABLES[module]!.table;
  return nameNode.elements.nodes.every(
    (el) =>
      !el.dotDotDotToken &&
      el.initializer === undefined &&
      el.name !== undefined &&
      ts.isIdentifier(el.name) &&
      (el.propertyName === undefined || ts.isIdentifier(el.propertyName)) &&
      own(
        table,
        ((el.propertyName as ts.Identifier | undefined) ?? (el.name as ts.Identifier)).text,
      ) !== undefined,
  );
}

/** Resolves an identifier bound by a builtinConstantsDestructureDecl to
 * its baked literal value. Null for every other binding. */
export function builtinConstantBindingOf(lowerer: Lowerer, ident: ts.Identifier): IrExpr | null {
  const symbol = lowerer.checker.getSymbolAtLocation(ident);
  const decl = symbol ? symbol.declarations[0] : undefined;
  if (!decl || !ts.isBindingElement(decl) || decl.dotDotDotToken || decl.initializer) return null;
  if (!ts.isObjectBindingPattern(decl.parent)) return null;
  const varDecl = decl.parent.parent;
  if (!ts.isVariableDeclaration(varDecl) || varDecl.initializer === undefined) return null;
  const module = builtinConstantsModuleOf(lowerer, varDecl.initializer);
  if (module === null) return null;
  const key =
    decl.propertyName && ts.isIdentifier(decl.propertyName)
      ? decl.propertyName.text
      : decl.name !== undefined && ts.isIdentifier(decl.name)
        ? decl.name.text
        : null;
  if (key === null) return null;
  const value = own(BUILTIN_CONSTANTS_TABLES[module]!.table, key);
  if (value === undefined) return null;
  return builtinConstLit(value, locOf(ident));
}

/** `zlib.constants` as a VALUE: the object Node's module answers — one
 * singleton per program, built on first use with the same table every
 * member read bakes (lowerBuiltinConstantsProperty), so identity,
 * `typeof`, `Object.keys`, spread and `JSON.stringify` see Node's object
 * rather than a fresh literal per use. The record is the `ZlibConstants`
 * shape the type mapper interns for the declared interface (the fields
 * match one for one); the members stay baked literals where the program
 * spells them, and the keys keep Node's insertion order (the table's). */
export function zlibConstantsValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const keys = Object.keys(ZLIB_CONSTANTS);
  const type: IrType & { kind: "record" } = {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      keys
        .map((name) => ({ name, type: F64 as IrType }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      false,
      undefined,
      keys,
    ),
  };
  const name = keyedHelperName(lowerer, "%builtin.zlib.constants", type.shapeId);
  if (lowerer.liftedFnNamed(name) === undefined) {
    const shape = lowerer.shapes.get(type.shapeId);
    const declared = new Set((shape?.fields ?? []).map((field) => field.name));
    if (declared.size !== keys.length || keys.some((key) => !declared.has(key)))
      throw new InternalCompilerError(
        "zlib.constants table and the ZlibConstants record shape disagree",
      );
    const fields = keys.map((name) => ({
      name,
      value: builtinConstLit(ZLIB_CONSTANTS[name]!, loc),
    }));
    // Node inserts the keys in table order and Object.keys observes it:
    // the literal carries the order.
    const literal = lowerer.keyOrder.literal(
      { kind: "recordLit", fields, type, loc },
      keys.map((name) => ({ kind: "key" as const, name, definite: true })),
    );
    const storage = `%g.${name}`;
    const ready = `${storage}%ready`;
    lowerer.globalsList.push(
      { id: storage, name: "zlib.constants", type, mutable: true },
      { id: ready, name: "%ready", type: BOOL, mutable: true },
    );
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: varRef(ready, BOOL, loc),
        then: [{ kind: "return", value: varRef(storage, type, loc), loc }],
        else_: null,
        loc,
      },
      { kind: "varDecl", localId: "constants.0", init: literal, loc },
      { kind: "assign", localId: storage, value: varRef("constants.0", type, loc), loc },
      {
        kind: "assign",
        localId: ready,
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        loc,
      },
      { kind: "return", value: varRef(storage, type, loc), loc },
    ];
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [{ id: "constants.0", name: "constants", type, mutable: false }],
      returnType: type,
      body,
      loc,
    });
  }
  lowerer.noteEdge(name);
  return { kind: "call", callee: name, args: [], type, loc };
}

/** `crypto.constants` as a VALUE: the object Node's module answers — one
 * singleton per program, built on first use from the same table every
 * member read bakes (lowerBuiltinConstantsProperty), so identity,
 * `typeof`, `Object.keys`, spread and `JSON.stringify` see Node's object
 * rather than a fresh literal per use. The record is the `CryptoConstants`
 * shape the type mapper interns for the declared interface (the fields
 * match one for one: the number constants and the two cipher-list
 * strings); the members stay baked literals where the program spells
 * them, and the keys keep Node's insertion order (the table's). */
export function cryptoConstantsValue(lowerer: Lowerer, loc: SrcLoc): IrExpr {
  const keys = Object.keys(CRYPTO_CONSTANTS);
  const fieldType = (name: string): IrType =>
    typeof CRYPTO_CONSTANTS[name] === "string" ? STRING : F64;
  const type: IrType & { kind: "record" } = {
    kind: "record",
    shapeId: lowerer.shapes.intern(
      keys
        .map((name) => ({ name, type: fieldType(name) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      false,
      undefined,
      keys,
    ),
  };
  const name = keyedHelperName(lowerer, "%builtin.crypto.constants", type.shapeId);
  if (lowerer.liftedFnNamed(name) === undefined) {
    const shape = lowerer.shapes.get(type.shapeId);
    const declared = new Set((shape?.fields ?? []).map((field) => field.name));
    if (declared.size !== keys.length || keys.some((key) => !declared.has(key)))
      throw new InternalCompilerError(
        "crypto.constants table and the CryptoConstants record shape disagree",
      );
    const fields = keys.map((name) => ({
      name,
      value: builtinConstLit(CRYPTO_CONSTANTS[name]!, loc),
    }));
    // Node inserts the keys in table order and Object.keys observes it:
    // the literal carries the order.
    const literal = lowerer.keyOrder.literal(
      { kind: "recordLit", fields, type, loc },
      keys.map((name) => ({ kind: "key" as const, name, definite: true })),
    );
    const storage = `%g.${name}`;
    const ready = `${storage}%ready`;
    lowerer.globalsList.push(
      { id: storage, name: "crypto.constants", type, mutable: true },
      { id: ready, name: "%ready", type: BOOL, mutable: true },
    );
    const body: IrStmt[] = [
      {
        kind: "if",
        cond: varRef(ready, BOOL, loc),
        then: [{ kind: "return", value: varRef(storage, type, loc), loc }],
        else_: null,
        loc,
      },
      { kind: "varDecl", localId: "constants.0", init: literal, loc },
      { kind: "assign", localId: storage, value: varRef("constants.0", type, loc), loc },
      {
        kind: "assign",
        localId: ready,
        value: { kind: "boolLit", value: true, type: BOOL, loc },
        loc,
      },
      { kind: "return", value: varRef(storage, type, loc), loc },
    ];
    lowerer.liftedFns.push({
      name,
      params: [],
      locals: [{ id: "constants.0", name: "constants", type, mutable: false }],
      returnType: type,
      body,
      loc,
    });
  }
  lowerer.noteEdge(name);
  return { kind: "call", callee: name, args: [], type, loc };
}

/** `constants.X_OK` where `constants` is a named fs import: the access-
 * mode bits bake as number literals (POSIX values — Node's own on the
 * supported hosts). Other fs.constants members (COPYFILE_*, O_*) fence
 * by name. Null for non-fs-constants receivers. */
export function lowerFsConstantsProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  if (!ts.isIdentifier(expr.expression)) return null;
  const bi = lowerer.builtinImportOf(expr.expression);
  if (!bi || bi.module !== "fs" || bi.member !== "constants") return null;
  const MODES: Record<string, number | undefined> = {
    F_OK: 0,
    X_OK: 1,
    W_OK: 2,
    R_OK: 4,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
  };
  const value = own(MODES, expr.name.text);
  if (value === undefined) return fsConstantMemberRead(expr);
  return { kind: "numLit", value, type: F64, loc: locOf(expr) };
}

/** fs.constants as a value: the target's null-prototype constants object,
 * built by the runtime from its own libc's macros. */
export function fsConstantsObject(loc: SrcLoc): IrExpr {
  return { kind: "libCall", fn: "fs.constants", args: [], type: DYN, loc };
}

/** `fs.constants.O_RDONLY` (any member the access-mode literals do not
 * cover): a read of the runtime object, so a constant the target lacks
 * reads as undefined in JavaScript and fails the number check in
 * TypeScript, whose declarations promise every name. */
export function fsConstantMemberRead(expr: ts.PropertyAccessExpression): IrExpr {
  const loc = locOf(expr);
  const read: IrExpr = {
    kind: "dynKeyGet",
    value: fsConstantsObject(loc),
    key: { kind: "strLit", value: expr.name.text, type: STRING, loc },
    type: DYN,
    loc,
  };
  return isJsSourceFile(ts.getSourceFileOfNode(expr))
    ? read
    : { kind: "dynCheck", value: read, type: F64, loc };
}
