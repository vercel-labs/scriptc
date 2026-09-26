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

// The first static profile adapts scripts to standalone strict modules. Be
// conservative about observable global-script semantics and helper reflection.
// Exclusions are runner limitations, never implementation support claims.
export function exclusion(source, meta, variant) {
  if (variant !== "strict") return `execution:${variant}`;
  if (meta.negative) return `negative-phase:${meta.negative.phase}`;
  if (meta.flags.includes("async")) return "execution:async";
  if (meta.flags.some((flag) => flag.startsWith("CanBlock"))) return "host:agents";
  const unsupportedIncludes = meta.includes.filter((name) => name !== "compareArray.js");
  if (unsupportedIncludes.length) return `harness-includes:${unsupportedIncludes.join(",")}`;
  const sf = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let reason;
  const forbidden = new Set(["$262", "$DONE", "$DONOTEVALUATE", "globalThis", "eval", "Function", "print", "process", "require", "arguments"]);
  const visit = (node) => {
    if (reason) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.ImportKeyword || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      reason = "host:script-environment";
    } else if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      reason = `host:${node.text}`;
    } else if (ts.isIdentifier(node) && node.text === "assert") {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        // assert(value, message)
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node &&
        ["sameValue", "notSameValue", "compareArray"].includes(parent.name.text) &&
        ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
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

export function prepare(source) {
  return `"use strict";\nimport { assert, Test262Error } from "./harness.ts";\n${source}\n;console.log(${JSON.stringify(completion)});\n`;
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
