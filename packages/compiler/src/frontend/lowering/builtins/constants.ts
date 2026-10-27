import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { canonicalBuiltinModule, isJsSourceFile, locOf, requireSpecOf } from "../../program.js";
import { builtinConstLit } from "../surfaces.js";
import { HTTP2_CONSTANTS } from "../http2-constants.js";
import { CRYPTO_CONSTANTS } from "../crypto-tables.js";
import { ZLIB_CONSTANTS } from "../zlib-constants.js";
import { DYN, F64, type IrExpr, STRING, type SrcLoc } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/** The builtin modules whose `constants` object bakes as literals at
 * every access site (the fs.constants precedent, scaled up): http2's
 * full Node v24 table, crypto's OpenSSL-constant table, and zlib's
 * table. The object itself never materializes at runtime. */
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
