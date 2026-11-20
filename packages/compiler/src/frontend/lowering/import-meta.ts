import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { dirname } from "node:path";
import * as posix from "node:path/posix";
import { pathToFileURL } from "node:url";
import { BOOL, DYN, STRING, type IrExpr, type IrGlobal } from "../../ir/ir.js";
import { wasiGuestPath } from "../../wasi-paths.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { defineRefusingFunction, refusingFunctionRef } from "./builtin-function-fences.js";
import { nodeValueDiag } from "../../diagnostics/diagnostic.js";
import { keyedHelperName } from "./stable-names.js";

export function isImportMeta(expr: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return (
    ts.isMetaProperty(expr) &&
    expr.keywordToken === ts.SyntaxKind.ImportKeyword &&
    expr.name.text === "meta"
  );
}

/** The module's file name as the compiled program reports it
 * (import.meta.filename): the WASI guest path on wasi targets. */
export function moduleFileName(lowerer: Lowerer, sf: ts.SourceFile): string {
  return lowerer.targetPlatform === "wasi"
    ? (wasiGuestPath(sf.fileName) ?? sf.fileName.replace(/\\/g, "/"))
    : sf.fileName;
}

/** File-backed metadata is fixed by the compiled module graph. Reads share
 * one implementation across dot access, folded keys and selected bindings. */
export function importMetaField(lowerer: Lowerer, node: ts.Node, name: string): IrExpr {
  const sf = ts.getSourceFileOfNode(node);
  const fileName = moduleFileName(lowerer, sf);
  const loc = locOf(node);
  switch (name) {
    case "env":
      return dynUndefinedExpr(loc);
    case "url":
      return {
        kind: "strLit",
        value: pathToFileURL(fileName, { windows: lowerer.targetPlatform === "win32" }).href,
        type: STRING,
        loc,
      };
    case "filename":
      return { kind: "strLit", value: fileName, type: STRING, loc };
    case "dirname":
      return {
        kind: "strLit",
        value: lowerer.targetPlatform === "wasi" ? posix.dirname(fileName) : dirname(fileName),
        type: STRING,
        loc,
      };
    case "main":
      return { kind: "boolLit", value: sf === lowerer.entry, type: BOOL, loc };
    case "resolve":
      return importMetaResolveFence(lowerer, node);
    default:
      lowerer.unsupported(
        "SC1090",
        node,
        `'import.meta.${name}' (only url, filename, dirname, main and resolve are members of the static metadata object; store import.meta in a variable to read or add other members)`,
      );
  }
}

/** Materialize only the selected data fields. Rest bindings would expose
 * the resolve callable and the mutable metadata object, so remain fenced. */
export function importMetaBindingSource(
  lowerer: Lowerer,
  pattern: ts.BindingName,
  initializer: ts.Expression,
): IrExpr | null {
  if (!isImportMeta(initializer) || !ts.isObjectBindingPattern(pattern)) return null;
  const fields: { name: string; value: IrExpr }[] = [];
  for (const el of pattern.elements.nodes) {
    if (el.dotDotDotToken)
      lowerer.unsupported(
        "SC1031",
        el,
        "rest bindings from import.meta (the metadata object has no static value representation)",
      );
    const key = el.propertyName ?? el.name;
    const name =
      ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)
        ? key.text
        : ts.isComputedPropertyName(key)
          ? lowerer.foldedStringKeyOf(key.expression)
          : null;
    if (name === null)
      lowerer.unsupported("SC1031", el, "import.meta bindings with runtime computed keys");
    if (!fields.some((field) => field.name === name))
      fields.push({ name, value: importMetaField(lowerer, el, name) });
  }
  const canonical = fields
    .map((field) => ({ name: field.name, type: field.value.type }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shapeId = lowerer.shapes.intern(
    canonical,
    false,
    undefined,
    fields.map((field) => field.name),
  );
  return { kind: "recordLit", fields, type: { kind: "record", shapeId }, loc: locOf(initializer) };
}

/** `import.meta.resolve` read as a value: a function with Node's name and
 * length that refuses when it is called. A direct
 * `import.meta.resolve(specifier)` call folds at build time
 * (importMetaResolveAnswer); a specifier computed elsewhere has no runtime
 * resolver in a compiled program. */
function importMetaResolveFence(lowerer: Lowerer, node: ts.Node): IrExpr {
  const loc = locOf(node);
  const diag = nodeValueDiag(
    "import.meta.resolve",
    loc,
    "call import.meta.resolve(...) directly with a static specifier; a stored or moved resolve function has no runtime resolver in a compiled program",
  );
  const lifted = "%builtin.fence.importMetaResolve";
  defineRefusingFunction(lowerer, lifted, diag, `${diag.message} [${diag.code}]`, loc);
  return refusingFunctionRef(lifted, "resolve", 1, loc);
}

/** `import.meta` read as a value: Node's metadata object for this module. It
 * is one checked-dynamic object per module, built on the first read and kept
 * in a module global, with Node's own members in Node's order. The object is
 * mutable and keeps its identity across reads, as Node's does.
 *
 * A direct `import.meta.resolve(specifier)` call folds at build time
 * (importMetaResolveAnswer); the object's `resolve` member is a function
 * value that refuses when it is called, because a compiled program has no
 * runtime resolver for a specifier computed elsewhere. */
export function importMetaValue(lowerer: Lowerer, node: ts.Node): IrExpr {
  const sf = ts.getSourceFileOfNode(node);
  const loc = locOf(node);
  let meta = lowerer.importMetaObjects.get(sf);
  if (meta === undefined) {
    const id = keyedHelperName(lowerer, "%g.importMeta", sf.fileName);
    const loadedId = `${id}%loaded`;
    const global: IrGlobal = { id, name: "%importMeta", type: DYN, mutable: true };
    lowerer.globalsList.push(global, { id: loadedId, name: "%loaded", type: BOOL, mutable: true });
    const fields = [
      { name: "dirname", value: importMetaField(lowerer, node, "dirname") },
      { name: "filename", value: importMetaField(lowerer, node, "filename") },
      { name: "main", value: importMetaField(lowerer, node, "main") },
      { name: "resolve", value: importMetaResolveFence(lowerer, node) },
      { name: "url", value: importMetaField(lowerer, node, "url") },
    ];
    const canonical = fields
      .map((field) => ({ name: field.name, type: field.value.type }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const shapeId = lowerer.shapes.intern(
      canonical,
      false,
      undefined,
      fields.map((field) => field.name),
    );
    const object: IrExpr = {
      kind: "dynFrom",
      value: { kind: "recordLit", fields, type: { kind: "record", shapeId }, loc },
      type: DYN,
      loc,
    };
    meta = { global, loadedId, object };
    lowerer.importMetaObjects.set(sf, meta);
  }
  /* The first read builds the object and stores it in the module global; every
   * later read answers that same object. Each site carries the lazy
   * initializer because a function that reads import.meta may run before the
   * statement that holds another read. */
  return {
    kind: "seqExpr",
    stmts: [
      {
        kind: "if",
        cond: {
          kind: "unary",
          op: "!",
          operand: { kind: "varRef", localId: meta.loadedId, type: BOOL, loc },
          type: BOOL,
          loc,
        },
        then: [
          {
            kind: "assign",
            localId: meta.loadedId,
            value: { kind: "boolLit", value: true, type: BOOL, loc },
            loc,
          },
          { kind: "assign", localId: meta.global.id, value: meta.object, loc },
        ],
        else_: null,
        loc,
      },
    ],
    result: varRef(meta.global.id, DYN, loc),
    type: DYN,
    loc,
  };
}
