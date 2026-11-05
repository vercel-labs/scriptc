import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Generates packages/compiler/src/ir/codec.generated.ts from the types in
// ir.ts: for every object type an IrModule can reach, an encoder that
// writes its fields by name in declaration order and a decoder that reads
// them back into an object literal of that type. Unions that `kind`
// discriminates are written as the member's index; other unions as the
// index of the arm a runtime test picks. The byte format is in codec.ts.
// `--check` fails when the file is stale.
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "package.json"));
const ts = require("typescript");
const irPath = join(root, "packages/compiler/src/ir/ir.ts");
const target = join(root, "packages/compiler/src/ir/codec.generated.ts");

const program = ts.createProgram([irPath], { strict: true, target: ts.ScriptTarget.ES2022 });
const checker = program.getTypeChecker();
const source = program.getSourceFile(irPath);

/** Exported type names of ir.ts, by the type they declare. */
const exported = new Map();
ts.forEachChild(source, (node) => {
  if (
    (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
    node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
    node.typeParameters === undefined
  ) {
    const type = checker.getTypeAtLocation(node.name);
    if (!exported.has(type)) exported.set(type, node.name.text);
  }
});
/** Exported names by the member set of the union or the single type they
 * declare: a field of type `IrExpr | undefined` codes its IrExpr part with
 * IrExpr's coder. */
const exportedBy = new Map();
for (const [type, name] of exported) {
  const parts = type.isUnion() ? type.types : [type];
  const key = parts
    .map((p) => p.id)
    .sort((a, b) => a - b)
    .join("|");
  if (!exportedBy.has(key)) exportedBy.set(key, name);
}
const partsKey = (parts) =>
  parts
    .map((p) => p.id)
    .sort((a, b) => a - b)
    .join("|");
const used = new Set(["IrModule", "IrFunction"]);
const moduleType = [...exported].find(([, name]) => name === "IrModule")[0];
const functionType = [...exported].find(([, name]) => name === "IrFunction")[0];

const F = ts.TypeFlags;
const NULLISH = F.Null | F.Undefined | F.Void;
const STRING = F.StringLike;
const NUMBER = F.NumberLike;
const BOOLEAN = F.BooleanLike;

/** An intersection no value has: `IrType & { kind: "record" }` distributes
 * over IrType's members, and all but one give `kind` two literal types. */
function impossible(type) {
  return type.isIntersection() && checker.typeToString(type) === "never";
}

/** The parts of `type` that are not null or undefined, and which of the two
 * it allows. */
function split(type) {
  const parts = type.isUnion() ? type.types : [type];
  return {
    present: parts.filter((part) => (part.flags & (NULLISH | F.Never)) === 0 && !impossible(part)),
    nullable: parts.some((part) => (part.flags & F.Null) !== 0),
    undefinable: parts.some((part) => (part.flags & (F.Undefined | F.Void)) !== 0),
  };
}

/** The literal value of `kind` on an object type, or null. */
function kindOf(type) {
  const kind = checker.getPropertyOfType(type, "kind");
  if (kind === undefined) return null;
  const kindType = checker.getTypeOfSymbol(kind);
  return kindType.isStringLiteral() ? kindType.value : null;
}

/** How a value of the non-nullish `parts` is coded. */
function shapeOf(parts, where) {
  for (const part of parts)
    if ((part.flags & (F.Any | F.Unknown)) !== 0) throw new Error(`untyped value at ${where}`);
  const objects = parts.filter((part) => (part.flags & (STRING | NUMBER | BOOLEAN)) === 0);
  const strings = parts.filter((part) => (part.flags & STRING) !== 0);
  const numbers = parts.filter((part) => (part.flags & NUMBER) !== 0);
  const booleans = parts.filter((part) => (part.flags & BOOLEAN) !== 0);
  if (objects.length === 0) {
    const scalarKinds = [strings, numbers, booleans].filter((list) => list.length > 0).length;
    if (scalarKinds === 1)
      return strings.length > 0
        ? { code: "string" }
        : numbers.length > 0
          ? { code: "number" }
          : { code: "bool" };
  }
  if (objects.length === 1 && strings.length + numbers.length + booleans.length === 0)
    return checker.isArrayType(objects[0])
      ? { code: "array", item: objects[0] }
      : { code: "object", type: objects[0] };
  if (
    objects.length > 1 &&
    strings.length + numbers.length + booleans.length === 0 &&
    objects.every((part) => kindOf(part) !== null && !checker.isArrayType(part))
  )
    return { code: "kinds", members: objects };
  // Arms told apart at run time: typeof for scalars, Array.isArray, a
  // `kind` literal, or a property only one object arm declares.
  const arms = [];
  if (strings.length > 0) arms.push({ test: "string", parts: strings });
  if (numbers.length > 0) arms.push({ test: "number", parts: numbers });
  if (booleans.length > 0) arms.push({ test: "boolean", parts: booleans });
  const arrays = objects.filter((part) => checker.isArrayType(part));
  if (arrays.length > 1) throw new Error(`several array types at ${where}`);
  if (arrays.length === 1) arms.push({ test: "array", parts: arrays });
  const records = objects.filter((part) => !checker.isArrayType(part));
  for (const record of records) {
    const own = checker.getPropertiesOfType(record).map((p) => p.name);
    const others = records.filter((other) => other !== record);
    const required = checker
      .getPropertiesOfType(record)
      .filter((p) => (p.flags & ts.SymbolFlags.Optional) === 0)
      .map((p) => p.name);
    let key = required.find((name) =>
      others.every((other) => checker.getPropertyOfType(other, name) === undefined),
    );
    // A property every arm has, whose object value has a key only this
    // arm's does (IrFfiParam's callback.id and callback.release).
    if (key === undefined)
      for (const outer of required) {
        const inner = (t) => {
          const p = checker.getPropertyOfType(t, outer);
          return p === undefined ? undefined : split(checker.getTypeOfSymbol(p)).present;
        };
        const mine = inner(record);
        if (mine?.length !== 1) continue;
        const found = checker
          .getPropertiesOfType(mine[0])
          .filter((p) => (p.flags & ts.SymbolFlags.Optional) === 0)
          .map((p) => p.name)
          .find((name) =>
            others.every((other) => {
              const theirs = inner(other);
              return (
                theirs === undefined ||
                theirs.every((t) => checker.getPropertyOfType(t, name) === undefined)
              );
            }),
          );
        if (found !== undefined) {
          key = `${outer}.${found}`;
          break;
        }
      }
    if (records.length > 1 && key === undefined)
      throw new Error(
        `no property tells ${checker.typeToString(record)} apart at ${where}: ${own.join(",")}`,
      );
    arms.push({ test: records.length === 1 ? "object" : `key:${key}`, parts: [record] });
  }
  return { code: "arms", arms };
}

// One encoder and one decoder per object type, union and array the module
// reaches, named by a number in the order they are first reached.
const coders = new Map();
const order = [];
function coderFor(parts, typeExpr, where) {
  const key = partsKey(parts);
  const known = coders.get(key);
  if (known !== undefined) return known;
  const shape = shapeOf(parts, where);
  if (shape.code === "string" || shape.code === "number" || shape.code === "bool") return shape;
  const exportedName = exportedBy.get(key);
  if (exportedName !== undefined) used.add(exportedName);
  const name = exportedName ?? `T${order.length}`;
  const coder = { ...shape, name, typeExpr: exportedName ?? typeExpr, where };
  coders.set(key, coder);
  order.push(coder);
  return coder;
}

/** The type expression of `parts`, `typeExpr` naming the field or element
 * type they come from. */
function presentExpr(typeExpr) {
  return `NonNullable<${typeExpr}>`;
}

/** Lines that write `value` of `type`, named `typeExpr`. A string field
 * named `file` is written with IrWriter.file, which notes it as a source
 * file the encoding names. */
function encodeValue(value, type, typeExpr, where, optional, field = null) {
  const { present, nullable, undefinable } = split(type);
  const coder = coderFor(present, presentExpr(typeExpr), where);
  const write =
    coder.code === "string"
      ? `w.${field === "file" ? "file" : "str"}(${value});`
      : coder.code === "number"
        ? `w.num(${value});`
        : coder.code === "bool"
          ? `w.bool(${value});`
          : `enc${coder.name}(w, ${value});`;
  if (!nullable && !undefinable && !optional) return [write];
  if (nullable && (undefinable || optional))
    return [
      `if (${value} === undefined) w.byte(0);`,
      `else if (${value} === null) w.byte(1);`,
      `else {`,
      `  w.byte(2);`,
      `  ${write}`,
      `}`,
    ];
  const missing = nullable ? "null" : "undefined";
  return [`if (${value} === ${missing}) w.byte(0);`, `else {`, `  w.byte(1);`, `  ${write}`, `}`];
}

/** An expression that reads a value of `type`; null-checks are statements
 * through `local`. */
function decodeValue(type, typeExpr, where, optional) {
  const { present, nullable, undefinable } = split(type);
  const coder = coderFor(present, presentExpr(typeExpr), where);
  // A scalar read is cast to its literal type (`17`, `true`, a union of
  // string literals), which the bytes cannot spell.
  const scalar = (call, plain) =>
    present.every((part) => part.flags === plain) ? call : `(${call} as ${presentExpr(typeExpr)})`;
  const read =
    coder.code === "string"
      ? scalar("r.str()", F.String)
      : coder.code === "number"
        ? scalar("r.num()", F.Number)
        : coder.code === "bool"
          ? present.length === 2
            ? "r.bool()"
            : `(r.bool() as ${presentExpr(typeExpr)})`
          : `dec${coder.name}(r)`;
  if (!nullable && !undefinable && !optional) return read;
  if (nullable && (undefinable || optional))
    return `r.tag(3, "${where}") === 0 ? undefined : r.lastTag === 1 ? null : ${read}`;
  return `r.tag(2, "${where}") === 0 ? ${nullable ? "null" : "undefined"} : ${read}`;
}

/** Field reads and writes of one object type. */
function objectLines(type, typeExpr, where, kind) {
  const enc = [];
  const dec = [];
  const fields = [];
  let index = 0;
  for (const property of checker.getPropertiesOfType(type)) {
    if (property.name === "kind" && kind !== null) continue;
    const fieldType = checker.getTypeOfSymbol(property);
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    const fieldExpr = `${typeExpr}[${JSON.stringify(property.name)}]`;
    const at = `${where}.${property.name}`;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property.name))
      throw new Error(`field name ${property.name} at ${where} is not an identifier`);
    const access = `v.${property.name}`;
    enc.push(...encodeValue(access, fieldType, fieldExpr, at, optional, property.name));
    const local = `f${index++}`;
    dec.push(`const ${local} = ${decodeValue(fieldType, fieldExpr, at, optional)};`);
    fields.push({ name: property.name, local, optional });
  }
  // The object is built with its fields in declaration order, an absent
  // optional field left out where it would stand: an object whose keys
  // follow that order (IrWriter.keys) reads back with the same key order.
  const literal = [
    ...(kind === null ? [] : [`kind: ${JSON.stringify(kind)}`]),
    ...fields.map((f) =>
      f.optional
        ? `...(${f.local} !== undefined ? { ${f.name}: ${f.local} } : {})`
        : `${f.name}: ${f.local}`,
    ),
  ];
  dec.push(`const o: ${typeExpr} = { ${literal.join(", ")} };`);
  dec.push("return o;");
  const declared = `KEYS${keyLists.length}`;
  keyLists.push(
    `const ${declared}: readonly string[] = ${JSON.stringify([...(kind === null ? [] : ["kind"]), ...fields.map((f) => f.name)])};`,
  );
  enc.unshift(`w.keys(Object.keys(v), ${declared});`);
  return { enc, dec };
}

/** The declared field names of each object type, for IrWriter.keys. */
const keyLists = [];

const body = [];
function emit(coder) {
  const { name, typeExpr } = coder;
  if (coder.code === "object") {
    const { enc, dec } = objectLines(coder.type, typeExpr, coder.where, null);
    body.push(
      `function enc${name}(w: IrWriter, v: ${typeExpr}): void {`,
      ...enc.map((l) => `  ${l}`),
      "}",
      `function dec${name}(r: IrReader): ${typeExpr} {`,
      ...dec.map((l) => `  ${l}`),
      "}",
      "",
    );
  } else if (coder.code === "array") {
    const item = checker.getTypeArguments(coder.item)[0];
    const itemExpr = `${typeExpr}[number]`;
    const at = `${coder.where}[]`;
    const enc = encodeValue("item", item, itemExpr, at, false);
    const dec = decodeValue(item, itemExpr, at, false);
    body.push(
      `function enc${name}(w: IrWriter, v: ${typeExpr}): void {`,
      "  w.length(v.length);",
      "  for (const item of v) {",
      ...enc.map((l) => `    ${l}`),
      "  }",
      "}",
      `function dec${name}(r: IrReader): ${typeExpr} {`,
      "  const length = r.length();",
      `  const out: ${typeExpr}[number][] = [];`,
      `  for (let i = 0; i < length; i++) out.push(${dec});`,
      "  return out;",
      "}",
      "",
    );
  } else if (coder.code === "kinds") {
    const members = [...coder.members].sort((a, b) => (kindOf(a) < kindOf(b) ? -1 : 1));
    const enc = [`function enc${name}(w: IrWriter, v: ${typeExpr}): void {`, "  switch (v.kind) {"];
    const dec = [`function dec${name}(r: IrReader): ${typeExpr} {`, `  switch (r.length()) {`];
    members.forEach((member, index) => {
      const kind = kindOf(member);
      const memberExpr = `Extract<${typeExpr}, { kind: ${JSON.stringify(kind)} }>`;
      const lines = objectLines(member, memberExpr, `${coder.where}<${kind}>`, kind);
      enc.push(
        `    case ${JSON.stringify(kind)}: {`,
        `      w.length(${index});`,
        ...lines.enc.map((l) => `      ${l}`),
        "      return;",
        "    }",
      );
      dec.push(`    case ${index}: {`, ...lines.dec.map((l) => `      ${l}`), "    }");
    });
    // A kind the union does not declare writes nothing that decodes.
    enc.push("  }", `  w.refuse("${name} kind " + String((v as { kind: unknown }).kind));`, "}");
    dec.push("  }", `  throw new Error("IR codec: invalid ${name} kind");`, "}", "");
    body.push(...enc, ...dec);
  } else if (coder.code === "arms") {
    const enc = [`function enc${name}(w: IrWriter, v: ${typeExpr}): void {`];
    const dec = [`function dec${name}(r: IrReader): ${typeExpr} {`, "  switch (r.length()) {"];
    coder.arms.forEach((arm, index) => {
      const armExpr =
        arm.test === "string" || arm.test === "number" || arm.test === "boolean"
          ? `Extract<${typeExpr}, ${arm.test}>`
          : arm.test === "array"
            ? `Extract<${typeExpr}, readonly unknown[]>`
            : arm.test === "object"
              ? `Exclude<${typeExpr}, string | number | boolean | readonly unknown[]>`
              : arm.test.includes(".")
                ? `Extract<${typeExpr}, { ${arm.test.slice(4).split(".")[0]}: { ${arm.test.slice(4).split(".")[1]}: unknown } }>`
                : `Extract<${typeExpr}, { ${arm.test.slice(4)}: unknown }>`;
      const test =
        arm.test === "string" || arm.test === "number" || arm.test === "boolean"
          ? `typeof v === ${JSON.stringify(arm.test)}`
          : arm.test === "array"
            ? "Array.isArray(v)"
            : arm.test === "object"
              ? "true"
              : arm.test.includes(".")
                ? `typeof v === "object" && ${JSON.stringify(arm.test.slice(4).split(".")[0])} in v && ${JSON.stringify(arm.test.slice(4).split(".")[1])} in (v as { ${arm.test.slice(4).split(".")[0]}: object }).${arm.test.slice(4).split(".")[0]}`
                : `typeof v === "object" && ${JSON.stringify(arm.test.slice(4))} in v`;
      const parts = arm.parts;
      const armCoder = coderFor(parts, armExpr, `${coder.where}|${index}`);
      const write =
        armCoder.code === "string"
          ? "w.str(v);"
          : armCoder.code === "number"
            ? "w.num(v);"
            : armCoder.code === "bool"
              ? "w.bool(v);"
              : `enc${armCoder.name}(w, v as ${armExpr});`;
      const read =
        armCoder.code === "string"
          ? "r.str()"
          : armCoder.code === "number"
            ? "r.num()"
            : armCoder.code === "bool"
              ? "r.bool()"
              : `dec${armCoder.name}(r)`;
      enc.push(`  if (${test}) {`, `    w.length(${index});`, `    ${write}`, "    return;", "  }");
      dec.push(`    case ${index}:`, `      return ${read} as ${typeExpr};`);
    });
    enc.push(`  throw new Error("IR codec: no arm of ${name} matches");`, "}");
    dec.push("  }", `  throw new Error("IR codec: invalid ${name} arm");`, "}", "");
    body.push(...enc, ...dec);
  }
}

coderFor([moduleType], "IrModule", "IrModule");
coderFor([functionType], "IrFunction", "IrFunction");
for (let index = 0; index < order.length; index++) emit(order[index]);

const lines = [
  "// Generated from packages/compiler/src/ir/ir.ts by scripts/generate-ir-codec.mjs.",
  "// Run `pnpm generate:ir-codec` after changing the IR's types.",
  `import type { ${[...used].sort().join(", ")} } from "./ir.js";`,
  'import type { IrReader, IrWriter } from "./codec.js";',
  "",
  "/** A digest of the coders below: an encoding written with other coders is",
  " * refused instead of misread, also after a change that keeps IR_VERSION. */",
  `export const IR_CODEC_LAYOUT = ${JSON.stringify(createHash("sha256").update(body.join("\n")).digest("hex").slice(0, 16))};`,
  "",
  "/** Writes `mod` field by field (codec.ts describes the bytes). */",
  "export function encodeIrModule(w: IrWriter, mod: IrModule): void {",
  "  encIrModule(w, mod);",
  "}",
  "/** Reads a module encodeIrModule wrote. */",
  "export function decodeIrModule(r: IrReader): IrModule {",
  "  return decIrModule(r);",
  "}",
  "/** Writes one function. */",
  "export function encodeIrFunction(w: IrWriter, fn: IrFunction): void {",
  "  encIrFunction(w, fn);",
  "}",
  "/** Reads a function encodeIrFunction wrote. */",
  "export function decodeIrFunction(r: IrReader): IrFunction {",
  "  return decIrFunction(r);",
  "}",
  "",
  ...keyLists,
  "",
  ...body,
];
const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text)
    throw new Error("codec.generated.ts is stale; run node scripts/generate-ir-codec.mjs");
} else writeFileSync(target, text);
