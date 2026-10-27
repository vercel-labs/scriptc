import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateAstViews } from "./generate-ts7-ast-views.mjs";

// The binary AST is an unstable TypeScript protocol. Generate its constants
// from the installed, pinned package; never translate TypeScript 5 numbers.
const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "packages/compiler/package.json"));
const packageRoot = dirname(require.resolve("typescript/package.json"));
const pinned = JSON.parse(readFileSync(join(root, "packages/compiler/package.json"), "utf8"))
  .dependencies.typescript;
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
if (version !== pinned)
  throw new Error(`Installed TypeScript ${version} differs from pin ${pinned}`);
const protocol = require(join(packageRoot, "dist/api/node/protocol.js"));
const { SyntaxKind } = require(join(packageRoot, "dist/enums/syntaxKind.js"));
const { NodeFlags } = require(join(packageRoot, "dist/enums/nodeFlags.js"));
const { ModifierFlags } = require(join(packageRoot, "dist/enums/modifierFlags.js"));

// The frontend's runtime enum surface is part of the same pinned protocol.
// Emit real enum declarations so member types retain the TS7/TS5 fence and
// reverse lookups keep the SDK's last-alias spelling.
const enumNames = [
  "InternalSymbolName",
  "ModifierFlags",
  "NodeFlags",
  "ScriptKind",
  "ScriptTarget",
  "SyntaxKind",
  "TokenFlags",
  "DiagnosticCategory",
  "ElementFlags",
  "ModuleKind",
  "NodeBuilderFlags",
  "ObjectFlags",
  "SignatureFlags",
  "SignatureKind",
  "SymbolFlags",
  "TypeFlags",
  "TypePredicateKind",
  "ModuleResolutionKind",
  "ModuleDetectionKind",
  "OuterExpressionKinds",
  "LanguageVariant",
  "JsxEmit",
];
const enumLines = [
  "/* eslint-disable @typescript-eslint/no-duplicate-enum-values -- TypeScript aliases are part of the protocol. */",
  `// Generated from typescript@${version} by scripts/generate-ts7-ast-schema.mjs.`,
  "// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.",
  "// Regenerate when changing the TypeScript pin; do not edit by hand.",
];
for (const name of enumNames) {
  const basename = name[0].toLowerCase() + name.slice(1);
  const declaration = readFileSync(
    join(packageRoot, "dist/enums", `${basename}.enum.d.ts`),
    "utf8",
  );
  const match = declaration.match(new RegExp(`export declare enum ${name} \\{[\\s\\S]*?\\n\\}`));
  if (!match) throw new Error(`Missing TypeScript enum: ${name}`);
  enumLines.push("", match[0].replace("export declare enum", "export enum"));
  if (
    [
      "SyntaxKind",
      "ScriptTarget",
      "ModuleKind",
      "ModuleResolutionKind",
      "ModuleDetectionKind",
      "JsxEmit",
    ].includes(name)
  ) {
    const values = require(join(packageRoot, "dist/enums", `${basename}.js`))[name];
    enumLines.push(
      "",
      `/** Numeric lookup with the SDK's aliases and undefined for unknown values. */`,
      `export function ${basename}Name(value: number): string | undefined {`,
      "  switch (value) {",
    );
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string" && Number.isFinite(Number(key)))
        enumLines.push(`    case ${key}: return ${JSON.stringify(value)};`);
    }
    enumLines.push("    default: return undefined;", "  }", "}");
  }
}
const enumOutput = enumLines.join("\n") + "\n";
const enumTarget = join(root, "packages/compiler/src/frontend/ts7/enums.generated.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(enumTarget, "utf8") !== enumOutput)
    throw new Error("TypeScript enums are stale; run node scripts/generate-ts7-ast-schema.mjs");
} else {
  writeFileSync(enumTarget, enumOutput);
}

const lines = [
  `// Generated from typescript@${version} by scripts/generate-ts7-ast-schema.mjs.`,
  "// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.",
  "// Regenerate when changing the TypeScript pin; do not edit by hand.",
  "",
];
for (const [key, value] of Object.entries(protocol)) {
  if (typeof value === "number") lines.push(`export const ${key} = ${value};`);
}
for (const [name, values] of [
  ["AstKind", SyntaxKind],
  ["AstNodeFlags", NodeFlags],
  ["AstModifierFlags", ModifierFlags],
]) {
  lines.push("", `export const ${name} = {`);
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number") lines.push(`  ${key}: ${value},`);
  }
  lines.push("} as const;");
}
lines.push(
  "",
  "/** Child properties in the exact order encoded by tsgo. */",
  "export function astChildNames(kind: number): string {",
  "  switch (kind) {",
);
for (const [kind, names] of Object.entries(protocol.childProperties)) {
  lines.push(`    case ${kind}: return ${JSON.stringify(names.join(","))}; // ${SyntaxKind[kind]}`);
}
lines.push('    default: return "";', "  }", "}", "");
// Named child access is a hot path in every frontend pass. Generate the
// ordinal lookup directly instead of allocating substrings per access.
// Share cases with the same child layout to keep the dispatch compact.
const childLayouts = new Map();
for (const [kind, names] of Object.entries(protocol.childProperties)) {
  if (names.length === 0) continue;
  const key = JSON.stringify(names);
  if (!childLayouts.has(key)) childLayouts.set(key, []);
  childLayouts.get(key).push(kind);
}
lines.push(
  "/** Wire slot for a child property, or -1 when the kind has no such child. */",
  "export function astChildOrder(kind: number, name: string): number {",
  "  switch (kind) {",
);
for (const [layout, kinds] of childLayouts) {
  for (const kind of kinds) lines.push(`    case ${kind}: // ${SyntaxKind[kind]}`);
  lines.push("      switch (name) {");
  for (const [index, name] of JSON.parse(layout).entries())
    lines.push(`        case ${JSON.stringify(name)}: return ${index};`);
  lines.push("        default: return -1;", "      }");
}
lines.push("    default: return -1;", "  }", "}", "");
const output = lines.join("\n");
const target = join(root, "packages/compiler/src/frontend/ts7/ast-schema.generated.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output)
    throw new Error("TypeScript AST schema is stale; run node scripts/generate-ts7-ast-schema.mjs");
} else {
  writeFileSync(target, output);
}

// The semantic client consumes the same pinned numeric discriminants as
// tsgo. Keep these independent of the SDK's runtime module graph too.
const semanticLines = [
  `// Generated from typescript@${version} by scripts/generate-ts7-ast-schema.mjs.`,
  "// TypeScript is Copyright Microsoft Corporation, licensed under Apache-2.0.",
  "// Regenerate when changing the TypeScript pin; do not edit by hand.",
];
for (const name of [
  "TypeFlags",
  "ObjectFlags",
  "SymbolFlags",
  "SignatureFlags",
  "SignatureKind",
  "TypePredicateKind",
]) {
  const basename = name[0].toLowerCase() + name.slice(1);
  const values = require(join(packageRoot, "dist/enums", `${basename}.js`))[name];
  semanticLines.push("", `export const Semantic${name} = {`);
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number") semanticLines.push(`  ${key}: ${value},`);
  }
  semanticLines.push("} as const;");
}
const protoDeclarations = readFileSync(join(packageRoot, "dist/api/proto.d.ts"), "utf8");
const semanticTypes = new Map([
  ["SymbolResponse", "SemanticSymbolData"],
  ["TypeResponse", "SemanticTypeData"],
  ["SignatureResponse", "SemanticSignatureData"],
  ["TypePredicateResponse", "SemanticTypePredicateData"],
  ["IndexInfoResponse", "SemanticIndexInfoData"],
]);
for (const [name] of semanticTypes) {
  const declaration = protoDeclarations.match(
    new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`),
  );
  if (!declaration) throw new Error(`Missing TypeScript semantic response: ${name}`);
  let text = declaration[0].replace(/\b(Path|__String)\b/g, "string");
  for (const [original, generated] of semanticTypes) text = text.replaceAll(original, generated);
  semanticLines.push("", text);
}
const semanticOutput = semanticLines.join("\n") + "\n";
const semanticTarget = join(
  root,
  "packages/compiler/src/frontend/ts7/semantic-schema.generated.ts",
);
if (process.argv.includes("--check")) {
  if (readFileSync(semanticTarget, "utf8") !== semanticOutput)
    throw new Error(
      "TypeScript semantic schema is stale; run node scripts/generate-ts7-ast-schema.mjs",
    );
} else {
  writeFileSync(semanticTarget, semanticOutput);
}

// Session metadata travels as ordinary JSON records. Generate its complete
// pinned shape too: parsing options or diagnostics must not pull SDK values
// into a statically compiled client through their type declarations.
const sessionTypes = new Map([
  ["CompilerOptions", "Ts7CompilerOptionsData"],
  ["InitializeResponse", "Ts7InitializeData"],
  ["ConfigResponse", "Ts7ConfigData"],
  ["UpdateSnapshotResponse", "Ts7SnapshotData"],
  ["ProjectResponse", "Ts7ProjectData"],
  ["SourceFileMetadata", "Ts7SourceMetadata"],
  ["SnapshotChanges", "Ts7SnapshotChangeData"],
  ["ProjectFileChanges", "Ts7ProjectChangeData"],
  ["Diagnostic", "Ts7DiagnosticData"],
]);
const sessionDeclarations =
  protoDeclarations +
  "\n" +
  readFileSync(join(packageRoot, "dist/api/compilerOptions.d.ts"), "utf8") +
  "\n" +
  readFileSync(join(packageRoot, "dist/api/sync/types.d.ts"), "utf8");
const sessionLines = semanticLines.slice(0, 3);
for (const [name] of sessionTypes) {
  const declaration = sessionDeclarations.match(
    new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`),
  );
  if (!declaration) throw new Error(`Missing TypeScript session response: ${name}`);
  const text = declaration[0].replace(/\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
    if (word === "Path") return "string";
    if (
      [
        "JsxEmit",
        "ModuleDetectionKind",
        "ModuleKind",
        "ModuleResolutionKind",
        "NewLineKind",
        "ScriptTarget",
        "DiagnosticCategory",
      ].includes(word)
    )
      return "number";
    return sessionTypes.get(word) ?? word;
  });
  sessionLines.push("", text);
}
const sessionOutput = sessionLines.join("\n") + "\n";
const sessionTarget = join(root, "packages/compiler/src/frontend/ts7/session-schema.generated.ts");
if (process.argv.includes("--check")) {
  if (readFileSync(sessionTarget, "utf8") !== sessionOutput)
    throw new Error(
      "TypeScript session schema is stale; run node scripts/generate-ts7-ast-schema.mjs",
    );
} else {
  writeFileSync(sessionTarget, sessionOutput);
}

// Child names alone cannot distinguish arrays from nodes (attributes and
// children can be either). Read that distinction from the pinned client's
// declarations, and require every wire property to have a declared getter.
const declarations = readFileSync(join(packageRoot, "dist/api/node/node.generated.d.ts"), "utf8");
const names = [...new Set(Object.values(protocol.childProperties).flat())].sort();
// These views adapt TS7's shared postfix slot and reparsed JSDoc bodies,
// return modifiers as a modifier list, and return write targets without their
// wrappers. Their implementations live outside the generated region in
// AstNode.
const adaptedGetters = new Set([
  "body",
  "initializer",
  "left",
  "modifiers",
  "operand",
  "questionToken",
]);
// A getter selects its child's wire slot by kind directly: an integer
// switch, without astChildOrder's switch on the child's name. `answer`
// maps a slot to the returned expression; `missing` is returned for kinds
// without the child.
const slotCases = (name, answer, missing) => {
  const kindsBySlot = new Map();
  for (const [kind, childNames] of Object.entries(protocol.childProperties)) {
    const slot = childNames.indexOf(name);
    if (slot < 0) continue;
    if (!kindsBySlot.has(slot)) kindsBySlot.set(slot, []);
    kindsBySlot.get(slot).push(kind);
  }
  const lines = ["    switch (this.kind) {"];
  for (const [slot, kinds] of [...kindsBySlot].sort((a, b) => a[0] - b[0])) {
    for (const kind of kinds) lines.push(`      case ${kind}:`);
    lines.push(`        return ${answer(slot)};`);
  }
  lines.push("      default:", `        return ${missing};`, "    }");
  return lines.join("\n");
};
const getters = names
  .filter((name) => !adaptedGetters.has(name))
  .map((name) => {
    const match = declarations.match(new RegExp(`get ${name}\\(\\): ([^;]+);`));
    if (!match) throw new Error(`Missing AST child declaration: ${name}`);
    const type = match[1]
      .replaceAll("RemoteNodeList", "AstNodeList")
      .replaceAll("RemoteNode", "AstNode");
    const method =
      type.includes("AstNode |") && type.includes("AstNodeList")
        ? "childAt"
        : type.includes("AstNodeList")
          ? "childListAt"
          : "childNodeAt";
    return `  get ${name}(): ${type} {\n${slotCases(name, (slot) => `this.${method}(${slot})`, "undefined")}\n  }`;
  });
// The adapted getters read their raw child through the same slot switch.
const adaptedSlots = [...adaptedGetters]
  .sort()
  .map(
    (name) =>
      `  private ${name}Slot(): number {\n${slotCases(name, (slot) => String(slot), "-1")}\n  }`,
  );
const nodeTarget = join(root, "packages/compiler/src/frontend/ts7/ast-node.ts");
const before = readFileSync(nodeTarget, "utf8");
if (
  !before.includes("// BEGIN GENERATED CHILD GETTERS") ||
  !before.includes("// END GENERATED CHILD GETTERS")
)
  throw new Error("Missing AST child getter generation markers");
const after = before.replace(
  /  \/\/ BEGIN GENERATED CHILD GETTERS[\s\S]*?  \/\/ END GENERATED CHILD GETTERS/,
  [
    "  // BEGIN GENERATED CHILD GETTERS",
    `  // Generated from typescript@${version}; run scripts/generate-ts7-ast-schema.mjs.`,
    ...getters,
    ...adaptedSlots,
    "  // END GENERATED CHILD GETTERS",
  ].join("\n"),
);
if (process.argv.includes("--check")) {
  if (before !== after)
    throw new Error(
      "TypeScript AST child getters are stale; run node scripts/generate-ts7-ast-schema.mjs",
    );
} else {
  writeFileSync(nodeTarget, after);
}
generateAstViews(root, packageRoot, version, process.argv.includes("--check"));
