import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Generates packages/compiler/src/ir/fields.generated.ts from the node types
// in ir.ts: for each IrExpr and IrStmt kind, the fields that can hold a
// string, read by name. Code that would enumerate a node's keys reads them
// through this switch instead: the native compiler enumerates and reads an
// untyped object's keys through its dynamic representation, one conversion
// per node. `--check` fails when the file is stale.
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "package.json"));
const ts = require("typescript");
const irPath = join(root, "packages/compiler/src/ir/ir.ts");
const target = join(root, "packages/compiler/src/ir/fields.generated.ts");
const samePath = (a, b) => a.replace(/\\/g, "/") === b.replace(/\\/g, "/");

/** The text of fields.generated.ts for `irText`, the source of ir.ts. */
export function generateIrFields(irText = readFileSync(irPath, "utf8")) {
  const options = { strict: true, target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  const readSourceFile = host.getSourceFile;
  // ir.ts is read from `irText`; the files it imports from disk.
  host.getSourceFile = (file, languageVersion, ...rest) =>
    samePath(file, irPath)
      ? ts.createSourceFile(file, irText, languageVersion)
      : readSourceFile.call(host, file, languageVersion, ...rest);
  const program = ts.createProgram([irPath], options, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(irPath);
  const aliases = new Map();
  ts.forEachChild(source, (node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node);
  });

  /** Whether a value of `type` can be a string. */
  function holdsString(type) {
    if (type.isUnion()) return type.types.some(holdsString);
    return (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  }

  /** Whether every value of `type` is a string. */
  function onlyString(type) {
    if (type.isUnion()) return type.types.every(onlyString);
    return (type.flags & ts.TypeFlags.StringLike) !== 0;
  }

  /** Each kind's string fields, in declaration order, merged over the unions:
   * a kind both unions declare lists the fields of both. */
  const kinds = new Map();
  for (const name of ["IrExpr", "IrStmt"]) {
    const alias = aliases.get(name);
    const union = checker.getTypeAtLocation(alias.name);
    for (const member of union.isUnion() ? union.types : [union]) {
      const kindSymbol = member.getProperty("kind");
      const kindType = checker.getTypeOfSymbolAtLocation(kindSymbol, alias);
      if (!kindType.isStringLiteral()) throw new Error(`${name} member without a literal kind`);
      const fields = kinds.get(kindType.value) ?? [];
      for (const property of member.getProperties()) {
        const type = checker.getTypeOfSymbolAtLocation(property, alias);
        if (!holdsString(type)) continue;
        const known = fields.find((field) => field.name === property.name);
        const always = onlyString(type) && (property.flags & ts.SymbolFlags.Optional) === 0;
        if (known === undefined) fields.push({ name: property.name, always });
        else known.always &&= always;
      }
      kinds.set(kindType.value, fields);
    }
  }

  const lines = [
    "// Generated from packages/compiler/src/ir/ir.ts by scripts/generate-ir-fields.mjs.",
    "// Run `pnpm generate:ir-fields` after changing the fields of an IR node.",
    'import type { IrExpr, IrStmt, IrType } from "./ir.js";',
    "",
    "/** Calls `visit` with each string field of `node` (including `kind`) and its",
    " * name: the string values `for (const key in node)` finds on a node, read",
    " * by name in the order ir.ts declares them. */",
    "export function eachStringField(",
    "  node: IrExpr | IrStmt,",
    "  visit: (value: string, field: string) => void,",
    "): void {",
    "  switch (node.kind) {",
  ];
  for (const [kind, fields] of [...kinds].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`    case ${JSON.stringify(kind)}: {`);
    for (const { name, always } of fields) {
      const read = `node.${name}`;
      if (always) lines.push(`      visit(${read}, ${JSON.stringify(name)});`);
      else
        lines.push(
          `      if (typeof ${read} === "string") visit(${read}, ${JSON.stringify(name)});`,
        );
    }
    lines.push("      return;", "    }");
  }
  lines.push("  }", "}", "");

  // The deep walkers: every field of every object under an IR node, as a
  // recursive key walk finds them, read by name.
  const members = new Map();
  for (const name of ["IrExpr", "IrStmt", "IrType"]) {
    const union = checker.getTypeAtLocation(aliases.get(name).name);
    members.set(name, new Set(union.isUnion() ? union.types : [union]));
  }
  const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
  const scalar =
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike;

  /** Whether every value of `type` is a number, boolean, bigint, symbol, null
   * or undefined. A record of such fields walks to nothing too, but it is an
   * object: its own fields are checked instead. */
  function onlyScalar(type) {
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((part) => (part.flags & (scalar | nullish)) !== 0);
  }

  /** The walker an IR union member belongs to, or null. */
  function irKind(type) {
    for (const [name, set] of members) if (set.has(type)) return name;
    return null;
  }

  let temp = 0;
  /** The fields each walked object type declares, for the type-level check at
   * the end of the file: `typeExpr` names the object type, `fields` every
   * field it had when the file was generated and `scalars` the fields that held
   * no string and no object then. */
  const checks = [];
  /** Records `property list` of `object` (named `typeExpr`) for the check. */
  function noteFields(typeExpr, properties, scalarNames) {
    checks.push({
      typeExpr,
      fields: properties.map((property) => property.name),
      scalars: scalarNames,
    });
  }
  /** Lines that walk `expr` of `type` (named `typeExpr` in the generated file):
   * strings to `walker.string`, IR nodes to their walkers, arrays by element and
   * other objects by field. */
  function walkLines(expr, type, typeExpr, indent, depth) {
    if (depth > 12) throw new Error(`field type nests too deep at ${expr}`);
    const parts = type.isUnion() ? type.types : [type];
    const present = parts.filter((part) => (part.flags & nullish) === 0);
    const optional = present.length !== parts.length;
    const strings = present.filter((part) => (part.flags & ts.TypeFlags.StringLike) !== 0);
    const objects = present.filter(
      (part) => (part.flags & (ts.TypeFlags.StringLike | scalar)) === 0,
    );
    for (const part of present)
      if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
        throw new Error(`untyped field ${expr}`);
    const body = [];
    if (objects.length > 0) {
      const kinds = new Set(objects.map(irKind));
      if (kinds.size === 1 && !kinds.has(null)) {
        const [kind] = kinds;
        body.push(`walk${kind.slice(2)}Fields(${expr}, walker, skipType);`);
      } else if (objects.every((part) => checker.isArrayType(part))) {
        if (objects.length !== 1) throw new Error(`several array types at ${expr}`);
        const item = `item${temp++}`;
        body.push(`for (const ${item} of ${expr}) {`);
        const itemType = `Extract<NonNullable<${typeExpr}>, readonly unknown[]>[number]`;
        body.push(
          ...walkLines(item, checker.getTypeArguments(objects[0])[0], itemType, "  ", depth + 1),
        );
        body.push("}");
      } else if (kinds.has(null) && objects.length === 1) {
        const recordType = `Extract<NonNullable<${typeExpr}>, object>`;
        const properties = checker.getPropertiesOfType(objects[0]);
        const scalarNames = [];
        for (const property of properties) {
          if (property.name === "loc") continue;
          const fieldType = checker.getTypeOfSymbol(property);
          const field = `${expr}.${property.name}`;
          const fieldTypeExpr = `${recordType}[${JSON.stringify(property.name)}]`;
          const lines = walkLines(field, fieldType, fieldTypeExpr, "", depth + 1);
          if (onlyScalar(fieldType)) scalarNames.push(property.name);
          if (lines.length === 0) continue;
          if (property.name === "type")
            body.push("if (!skipType) {", ...lines.map((l) => `  ${l}`), "}");
          else body.push(...lines);
        }
        noteFields(recordType, properties, scalarNames);
      } else throw new Error(`mixed object types at ${expr}: ${checker.typeToString(type)}`);
    }
    let lines = body;
    if (strings.length > 0 && objects.length > 0)
      lines = [
        `if (typeof ${expr} === "string") walker.string(${expr});`,
        ...(body.length > 0 ? [`else {`, ...body.map((l) => `  ${l}`), "}"] : []),
      ];
    else if (strings.length > 0) lines = [`walker.string(${expr});`];
    if (lines.length > 0 && optional && !(strings.length > 0 && objects.length > 0))
      lines = [
        `if (${expr} !== undefined && ${expr} !== null) {`,
        ...lines.map((l) => `  ${l}`),
        "}",
      ];
    else if (lines.length > 0 && optional)
      lines = [
        `if (${expr} !== undefined && ${expr} !== null) {`,
        ...lines.map((l) => `  ${l}`),
        "}",
      ];
    return lines.map((line) => indent + line);
  }

  lines.push(
    "/** What a field walk reports (walkExprFields): each expression and",
    " * statement node before its fields, and each string a field holds. */",
    "export interface IrFieldWalker {",
    "  node(node: IrExpr | IrStmt): void;",
    "  string(value: string): void;",
    "}",
    "",
  );
  for (const name of ["IrExpr", "IrStmt", "IrType"]) {
    const short = name.slice(2);
    const nodeCall = name === "IrType" ? [] : ["  walker.node(node);"];
    lines.push(
      `/** Walks every field of \`node\` but \`loc\` (and \`type\` with \`skipType\`), and`,
      " * every field of each object under it: the strings and nodes a recursive",
      " * `for (const key in value)` walk with the same skips finds, read by name in",
      " * the order ir.ts declares the fields. */",
      `export function walk${short}Fields(node: ${name}, walker: IrFieldWalker, skipType: boolean): void {`,
      ...nodeCall,
      "  switch (node.kind) {",
    );
    const byKind = new Map();
    for (const member of members.get(name)) {
      const kind = checker.getTypeOfSymbol(member.getProperty("kind")).value;
      if (byKind.has(kind)) throw new Error(`${name} kind ${kind} declared twice`);
      byKind.set(kind, member);
    }
    for (const [kind, member] of [...byKind].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push(`    case ${JSON.stringify(kind)}: {`);
      const memberType = `Extract<${name}, { kind: ${JSON.stringify(kind)} }>`;
      const scalarNames = [];
      for (const property of member.getProperties()) {
        if (property.name === "loc") continue;
        const fieldType = checker.getTypeOfSymbol(property);
        const field = `node.${property.name}`;
        const fieldTypeExpr = `${memberType}[${JSON.stringify(property.name)}]`;
        const walk = walkLines(field, fieldType, fieldTypeExpr, "", 0);
        if (onlyScalar(fieldType)) scalarNames.push(property.name);
        if (walk.length === 0) continue;
        if (property.name === "type")
          lines.push("      if (!skipType) {", ...walk.map((l) => `        ${l}`), "      }");
        else lines.push(...walk.map((l) => `      ${l}`));
      }
      lines.push("      return;", "    }");
      noteFields(memberType, member.getProperties(), scalarNames);
    }
    lines.push("  }", "}", "");
  }

  // Type checking fails below when ir.ts gives a walked object a field this
  // file does not know, or lets a field that held no string and no object hold
  // one before this file is regenerated.
  const quoted = (names) => names.map((name) => JSON.stringify(name)).join(" | ");
  lines.push(
    "/** A field ir.ts declares that this file does not read. */",
    "type FieldsNotRead<T, Read extends PropertyKey> = Exclude<keyof T, Read>;",
    "/** The string or object values a field read as a scalar can hold. */",
    "type ValuesNotRead<T> = Extract<NonNullable<T>, string | object>;",
    "/** Fails type checking unless `T` is never: run `pnpm generate:ir-fields`. */",
    "type Unread<T extends never> = T;",
    "",
    "/** Every walked object type's fields as ir.ts declared them when this file",
    " * was generated. */",
    "export type IrFieldsCurrent = [",
  );
  for (const { typeExpr, fields, scalars } of checks) {
    lines.push(
      `  Unread<FieldsNotRead<${typeExpr}, ${fields.length > 0 ? quoted(fields) : "never"}>>,`,
    );
    for (const scalarName of scalars)
      lines.push(`  Unread<ValuesNotRead<${typeExpr}[${JSON.stringify(scalarName)}]>>,`);
  }
  lines.push("];", "");
  return lines.join("\n");
}

if (process.argv[1] !== undefined && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const text = generateIrFields();

  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== text)
      throw new Error("fields.generated.ts is stale; run node scripts/generate-ir-fields.mjs");
  } else writeFileSync(target, text);
}
