import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load, JSON_SCHEMA } from "js-yaml";
import ts from "typescript";

export const directory = fileURLToPath(new URL(".", import.meta.url));
export const vendorRoot = join(directory, "vendor");
export const pin = JSON.parse(readFileSync(join(directory, "upstream.json"), "utf8"));
export const completion = "__scriptc_test262_complete__";
export const harnessSource = readFileSync(join(directory, "harness.ts"), "utf8");
export const assertThrowsSource = readFileSync(join(directory, "assert-throws.js"), "utf8");
export const expectations = JSON.parse(readFileSync(join(directory, "expectations.json"), "utf8"));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function filesBelow(root, prefix) {
  const paths = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...filesBelow(root, path));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Test262 snapshot contains a non-regular entry: ${path}`);
  }
  return paths.sort();
}

// Covers fixtures and harness files too; a checkout with edited tests cannot
// silently claim the pinned revision. Paths are POSIX on every host.
export function snapshotDigest(root) {
  const paths = ["LICENSE", ...filesBelow(root, "harness"), ...filesBelow(root, "test")].sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path).update("\0").update(sha256(readFileSync(join(root, path)))).update("\n");
  }
  return hash.digest("hex");
}

export function verifyVendor() {
  for (const [path, expected] of Object.entries(pin.files)) {
    if (sha256(readFileSync(join(vendorRoot, path))) !== expected) {
      throw new Error(`Pinned Test262 file changed: ${path}`);
    }
  }
}

export function testPaths(root) {
  return filesBelow(root, "test").filter((path) => path.endsWith(".js") && !path.includes("_FIXTURE"));
}

const knownFlags = new Set([
  "onlyStrict", "noStrict", "module", "raw", "async", "generated",
  "CanBlockIsFalse", "CanBlockIsTrue", "non-deterministic",
]);

export function metadata(source, path = "test.js") {
  const match = /\/\*---([\s\S]*?)---\*\//.exec(source);
  if (!match) throw new Error(`${path}: missing Test262 frontmatter`);
  const value = load(match[1], { schema: JSON_SCHEMA });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: invalid metadata`);
  for (const key of ["flags", "includes", "features"]) {
    value[key] ??= [];
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new Error(`${path}: invalid ${key}`);
    }
  }
  for (const flag of value.flags) {
    if (!knownFlags.has(flag)) throw new Error(`${path}: unknown flag ${flag}`);
  }
  if (value.flags.includes("onlyStrict") && value.flags.includes("noStrict")) {
    throw new Error(`${path}: conflicting execution flags`);
  }
  if (value.negative && (!['parse', 'resolution', 'runtime'].includes(value.negative.phase) || typeof value.negative.type !== "string")) {
    throw new Error(`${path}: invalid negative metadata`);
  }
  return value;
}

export function variants(meta) {
  if (meta.flags.includes("module")) return ["module"];
  if (meta.flags.includes("raw")) return ["raw"];
  if (meta.flags.includes("onlyStrict")) return ["strict"];
  if (meta.flags.includes("noStrict")) return ["sloppy"];
  return ["sloppy", "strict"];
}

function hasOwnThisBinding(node) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isFunctionLike(parent) && child === parent.body) return true;
    if (ts.isPropertyDeclaration(parent) && child === parent.initializer) return true;
    if (ts.isClassStaticBlockDeclaration(parent) && child === parent.body) return true;
  }
  return false;
}

// The first static profile adapts scripts to standalone strict modules. Be
// conservative about observable global-script semantics and helper reflection.
// Exclusions are runner limitations, never implementation support claims.
export function exclusion(source, meta, variant) {
  if (meta.negative) {
    if (meta.negative.phase !== "parse" || meta.negative.type !== "SyntaxError" || (variant !== "strict" && variant !== "sloppy")) {
      return `negative-phase:${meta.negative.phase}`;
    }
    return undefined;
  }
  if (variant !== "strict" && variant !== "sloppy") return `execution:${variant}`;
  if (meta.flags.some((flag) => flag.startsWith("CanBlock"))) return "host:agents";
  const unsupportedIncludes = meta.includes.filter((name) => name !== "compareArray.js");
  if (unsupportedIncludes.length) return `harness-includes:${unsupportedIncludes.join(",")}`;
  const sf = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let reason;
  const forbidden = new Set(["$262", "$DONE", "$DONOTEVALUATE", "globalThis", "eval", "Function", "print", "process", "require", "arguments"]);
  if (variant === "sloppy") for (const name of ["module", "exports", "__dirname", "__filename"]) forbidden.add(name);
  if (meta.flags.includes("async")) forbidden.delete("$DONE");
  const visit = (node) => {
    if (reason) return;
    if ((node.kind === ts.SyntaxKind.ThisKeyword && !hasOwnThisBinding(node)) ||
      node.kind === ts.SyntaxKind.ImportKeyword || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      reason = "host:script-environment";
    } else if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      reason = `host:${node.text}`;
    } else if (ts.isIdentifier(node) && node.text === "assert") {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        // assert(value, message)
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node &&
        ts.isCallExpression(parent.parent) && parent.parent.expression === parent &&
        (["sameValue", "notSameValue", "compareArray"].includes(parent.name.text) ||
          (parent.name.text === "throws" &&
            parent.parent.arguments[0] !== undefined &&
            ts.isIdentifier(parent.parent.arguments[0]) &&
            ["Error", "TypeError", "RangeError", "SyntaxError"].includes(parent.parent.arguments[0].text)))
      ) {
        // Supported assertion calls; aliases, mutations, and reflection stay out.
      } else reason = "harness:assert-surface";
    } else if (meta.includes.includes("compareArray.js") && ts.isIdentifier(node) && node.text === "compareArray" &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && ts.isIdentifier(node.parent.expression) && node.parent.expression.text === "assert")) {
      reason = "harness:compareArray-surface";
    } else if (ts.isIdentifier(node) && node.text === "Test262Error") {
      if (!ts.isNewExpression(node.parent) || node.parent.expression !== node) reason = "harness:Test262Error-surface";
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reason;
}

export function prepare(source, asyncTest = false, marker = completion, variant = "strict") {
  const names = asyncTest ? "assert, Test262Error, $DONE" : "assert, Test262Error";
  const end = asyncTest ? "" : `;console.log(${JSON.stringify(marker)});\n`;
  if (variant === "sloppy") return `const { ${names} } = require("./harness.ts");\n${source}\n${end}`;
  return `"use strict";\nimport { ${names} } from "./harness.ts";\n${source}\n${end}`;
}

function parseDiagnostics(source, variant) {
  if (variant !== "strict" && variant !== "sloppy") return [];
  const prepared = prepare(source, false, completion, variant);
  const sourceStart = prepared.indexOf(source);
  const sourceEnd = sourceStart + source.length;
  const file = ts.createSourceFile(variant === "sloppy" ? "main.cjs" : "main.js", prepared, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const raw = variant === "sloppy"
    ? ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics
    : [];
  return file.parseDiagnostics.filter((diagnostic) =>
    diagnostic.start >= sourceStart && diagnostic.start < sourceEnd &&
    (variant === "strict" || raw.some((item) =>
      item.start === diagnostic.start - sourceStart &&
      ts.flattenDiagnosticMessageText(item.messageText, "\n") ===
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))));
}

// TypeScript reports these JavaScript grammar and early errors in its semantic
// pass. Matching the compiler's diagnostic at the original source location
// keeps type-checking errors and the harness's $DONOTEVALUATE error out.
const earlyErrorCodes = new Set([
  1005, 1013, 1048, 1091, 1107, 1108, 1115, 1116, 1136, 1155, 1156, 1186,
  1190, 1213, 1214, 1215, 1325, 1346, 1347, 1358, 1359,
  1499, 1500, 1502, 1504, 1505, 1506, 1507, 1508, 1509, 1510, 1511, 1512,
  1513, 1514, 1515, 1516, 1517, 1518, 1519, 1520, 1521, 1522, 1523, 1524,
  1525, 1526, 1527, 1528, 1529, 1530, 1531, 1532, 1533, 1534, 1535,
  18006, 18011, 18012, 18016, 2300, 2337, 2364, 2451, 2462, 2491, 2523,
  2779, 2804, 17012, 18061,
]);

function earlyErrorDiagnostics(source, variant) {
  const prepared = prepare(source, false, completion, variant);
  const start = prepared.indexOf(source);
  const end = start + source.length;
  const suffix = variant === "sloppy" ? "main.cjs" : "main.js";
  const fileName = join(directory, "__test262_parse__", suffix);
  const isMain = (path) => path.replaceAll("\\", "/").endsWith(`/__test262_parse__/${suffix}`);
  const options = {
    allowJs: true, checkJs: true, noEmit: true, noLib: true, types: [],
    strict: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = isMain;
  host.readFile = (path) => isMain(path) ? prepared : undefined;
  host.getSourceFile = (path, languageVersion) =>
    isMain(path) ? ts.createSourceFile(path, prepared, languageVersion, true) : undefined;
  const program = ts.createProgram([fileName], options, host);
  const file = program.getSourceFile(fileName);
  if (!file) return [];
  return program.getSemanticDiagnostics(file).filter((diagnostic) =>
    earlyErrorCodes.has(diagnostic.code) && diagnostic.start >= start && diagnostic.start < end &&
    !(variant === "sloppy" && (diagnostic.code === 1214 || diagnostic.code === 1215)));
}

export function matchesParseNegative(outcome, source, variant = "strict") {
  if (outcome.status !== "compile-refusal") return false;
  const matches = (parsed) => outcome.diagnostics?.some((reported) =>
    reported.code === "SC0001" &&
    reported.loc?.file?.endsWith(variant === "sloppy" ? "/main.cjs" : "/main.js") &&
    reported.loc.start === parsed.start &&
    reported.message === ts.flattenDiagnosticMessageText(parsed.messageText, "\n"));
  return parseDiagnostics(source, variant).some(matches) || earlyErrorDiagnostics(source, variant).some(matches);
}

export function summarize(results) {
  const counts = {};
  const exclusions = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    if (result.status === "excluded") exclusions[result.reason] = (exclusions[result.reason] ?? 0) + 1;
  }
  return { counts, exclusions };
}

export function compileFailureStatus(diagnostics) {
  if (diagnostics.some((d) => d.code === "SC0004" || /^SC9/.test(d.code))) return "compiler-error";
  if (diagnostics.some((d) => d.code === "SC3003" || d.code === "SC3004")) return "build-error";
  if (diagnostics.some((d) => d.loc?.file?.endsWith("harness.ts"))) return "harness-refusal";
  return "compile-refusal";
}

export function matchesExpectation(id, outcome) {
  const expected = expectations[id];
  if (!expected) return outcome.status === "pass";
  return outcome.status === expected.status && outcome.reason === expected.reason &&
    outcome.stderr?.includes(expected.detail) === true;
}
