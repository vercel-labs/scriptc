import { dynUndefinedExpr } from "../../ir/build.js";
import { dirname } from "node:path";
import * as posix from "node:path/posix";
import { pathToFileURL } from "node:url";
import { BOOL, STRING, type IrExpr } from "../../ir/ir.js";
import { wasiGuestPath } from "../../wasi-paths.js";
import { locOf } from "../program.js";
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";

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
    default:
      lowerer.unsupported(
        "SC1090",
        node,
        `'import.meta.${name}' (only url, filename, dirname, and main are supported in static ESM)`,
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
