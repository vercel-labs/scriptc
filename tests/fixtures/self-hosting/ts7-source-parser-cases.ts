import { readFileSync, writeFileSync } from "node:fs";
import { Ts7SourceParser, type Ts7SourceKind } from "../../../packages/compiler/src/frontend/ts7/source-parser.js";
import * as syntax from "../../../packages/compiler/src/frontend/ts7/syntax.js";
import * as declarations from "../../../packages/compiler/src/frontend/npm-static-declaration-syntax.js";
import { moduleSpecifiersOfFile, sourceImportsOfFile } from "../../../packages/compiler/src/frontend/module-syntax.js";

interface SyntaxRequest {
  files: { path: string; text: string; kind: Ts7SourceKind }[];
  packages: { declarations: string; source: string }[];
}

export function runSourceParser(parser: Ts7SourceParser, input: string, output: string): void {
  const request = JSON.parse(readFileSync(input, "utf8")) as SyntaxRequest;
  const files = request.files.map((item) => {
    const file = parser.parse(item.path, item.text, item.kind);
    let nodes = 0;
    let optional = 0;
    const kinds = new Set([syntax.SyntaxKind.Identifier, syntax.SyntaxKind.CallExpression]);
    const expected: string[] = [];
    syntax.walkPreorder(file, (node, depth) => {
      nodes++;
      if (node.questionToken !== undefined) optional++;
      if (kinds.has(node.kind)) expected.push(`${node.kind}:${node.pos}:${depth}`);
    });
    const selected: string[] = [];
    syntax.walkPreorder(file, (node, depth) => {
      selected.push(`${node.kind}:${node.pos}:${depth}`);
    }, kinds);
    if (JSON.stringify(selected) !== JSON.stringify(expected)) throw new Error("selective traversal changed syntax order or depth");
    return {
      text: file.text,
      nodes,
      optional,
      declaration: file.isDeclarationFile,
      statements: file.statements.map((statement) => ({
        text: statement.getText(), start: statement.getStart(), end: statement.end,
      })),
      imports: moduleSpecifiersOfFile(file),
      sourceImports: sourceImportsOfFile(file),
    };
  });
  const packages = request.packages.map((item) => {
    const declaredFile = parser.parse("package.d.ts", item.declarations, "ts");
    const overloads = declarations.parseNpmStaticDeclarationOverloads(declaredFile);
    const properties = declarations.parseNpmStaticDeclarationProperties(declaredFile);
    const file = parser.parse("package.js", item.source, "js");
    const names = new Set<string>();
    for (const name of overloads.keys()) names.add(name);
    for (const name of properties.keys()) names.add(name);
    const targets = declarations.npmStaticRuntimeClassTargets(file, item.source, names);
    const annotatedMethods = declarations.applyNpmStaticDeclarationOverloads(file, item.source, overloads);
    const annotatedFields = declarations.applyNpmStaticDeclarationProperties(file, item.source, properties);
    const nullable = declarations.applyNpmStaticNullableClassFields(file, item.source);
    const find = declarations.applyNpmStaticFindReturnWidening(file, item.source);
    const methodAgain = annotatedMethods === null ? null : declarations.applyNpmStaticDeclarationOverloads(
      parser.parse("package.js", annotatedMethods.text, "js"), annotatedMethods.text, overloads,
    );
    const fieldAgain = annotatedFields === null ? null : declarations.applyNpmStaticDeclarationProperties(
      parser.parse("package.js", annotatedFields.text, "js"), annotatedFields.text, properties,
    );
    const nullableAgain = nullable === null ? null : declarations.applyNpmStaticNullableClassFields(
      parser.parse("package.js", nullable.text, "js"), nullable.text,
    );
    const findAgain = find === null ? null : declarations.applyNpmStaticFindReturnWidening(
      parser.parse("package.js", find.text, "js"), find.text,
    );
    const overloadReport: { name: string; methods: { method: string; signatures: readonly declarations.NpmStaticOverloadSignature[] }[] }[] = [];
    for (const [name, methods] of overloads) {
      const methodReport: { method: string; signatures: readonly declarations.NpmStaticOverloadSignature[] }[] = [];
      for (const [method, signatures] of methods) methodReport.push({ method, signatures });
      overloadReport.push({ name, methods: methodReport });
    }
    const propertyReport: { name: string; fields: { field: string; type: string }[] }[] = [];
    for (const [name, fields] of properties) {
      const fieldReport: { field: string; type: string }[] = [];
      for (const [field, type] of fields) fieldReport.push({ field, type });
      propertyReport.push({ name, fields: fieldReport });
    }
    const targetReport: { name: string; target: declarations.NpmStaticRuntimeClassTarget }[] = [];
    for (const [name, target] of targets) targetReport.push({ name, target });
    return {
      overloads: overloadReport,
      properties: propertyReport,
      reexports: declarations.npmStaticDeclarationReexports(declaredFile),
      targets: targetReport,
      annotatedMethods, annotatedFields, nullable, find,
      methodAgain, fieldAgain, nullableAgain, findAgain,
    };
  });
  // Parse a file, retire its snapshot, edit the same path, and retain both
  // independent ASTs through subsequent requests and session shutdown.
  const original = parser.parse("versions.ts", "export const before = 1;", "ts");
  const updated = parser.parse("versions.ts", "export const after = 2;", "ts");
  for (let version = 0; version < 32; version++) {
    const source = `export const version = ${version};`;
    const file = parser.parse("bounded.ts", source, "ts");
    if (file.text !== source) throw new Error("stale source parser result");
  }
  parser.close();
  parser.close();
  const versions = [original.statements[0]!.getText(), updated.statements[0]!.getText()];
  let closed = false;
  try { parser.parse("late.ts", "", "ts"); } catch { closed = true; }
  writeFileSync(output, JSON.stringify({ files, packages, versions, closed }));
}
