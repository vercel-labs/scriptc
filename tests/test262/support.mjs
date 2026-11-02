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
export const propertyHelperSource = readFileSync(join(directory, "property-helper.js"), "utf8");
export const typedArrayHelperSource = readFileSync(join(directory, "test-typed-array.js"), "utf8");
const adaptedIncludes = new Set(["compareArray.js", "propertyHelper.js", "testTypedArray.js"]);
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

const unsupportedPropertyHelpers = new Set([
  "verifyCallableProperty", "verifyAccessorProperty", "verifyEqualTo", "verifyWritable", "verifyNotWritable",
  "verifyEnumerable", "verifyNotEnumerable", "verifyConfigurable", "verifyNotConfigurable",
  "verifyPrimordialProperty", "verifyPrimordialCallableProperty", "verifyPrimordialAccessorProperty",
  "isWritable", "isEnumerable", "isConfigurable", "isSameValue",
]);
const descriptorFields = new Set(["value", "writable", "enumerable", "configurable", "get", "set"]);

function inlinePropertyDescriptor(node) {
  if (!node) return false;
  if (ts.isIdentifier(node) && node.text === "undefined") return true;
  return ts.isObjectLiteralExpression(node) && node.properties.every((field) =>
    ts.isPropertyAssignment(field) && ts.isIdentifier(field.name) && descriptorFields.has(field.name.text));
}

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

function argumentsOwner(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isFunctionLike(parent) && parent.body) return parent;
  }
  return undefined;
}

// The only exclusions the island lane lifts (decision S4): each of these
// names a construct the standalone strict adapter cannot express but Node's
// own engine can, and an island variant runs under Node. Everything else —
// the harness includes, the assertion surface, `$262` — stays excluded,
// because the adapter still has to run for an island too.
const LIFTED_IN_ISLAND = new Set([
  "host:eval",
  "host:Function",
  "host:arguments",
  "host:script-environment",
  "host:globalThis",
]);

// The first static profile adapts scripts to standalone strict modules. Be
// conservative about observable global-script semantics and helper reflection.
// Exclusions are runner limitations, never implementation support claims.
// `islands` reports which variants the island lane could measure: it never
// widens the native profile, and it lifts the five host reasons on sloppy
// variants only.
export function exclusion(source, meta, variant, islands = false) {
  if (meta.negative) {
    if (meta.negative.phase !== "parse" || meta.negative.type !== "SyntaxError" || (variant !== "strict" && variant !== "sloppy")) {
      return `negative-phase:${meta.negative.phase}`;
    }
    return undefined;
  }
  if (variant !== "strict" && variant !== "sloppy") return `execution:${variant}`;
  if (meta.flags.some((flag) => flag.startsWith("CanBlock"))) return "host:agents";
  const unsupportedIncludes = meta.includes.filter((name) => !adaptedIncludes.has(name));
  if (unsupportedIncludes.length) return `harness-includes:${unsupportedIncludes.join(",")}`;
  const sf = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let reason;
  const propertyHelper = meta.includes.includes("propertyHelper.js");
  const typedArrayHelper = meta.includes.includes("testTypedArray.js");
  const forbidden = new Set(["$262", "$DONE", "$DONOTEVALUATE", "globalThis", "eval", "Function", "print", "process", "require"]);
  if (variant === "sloppy") for (const name of ["module", "exports", "__dirname", "__filename"]) forbidden.add(name);
  if (meta.flags.includes("async")) forbidden.delete("$DONE");
  const liftable = (item) => islands && variant === "sloppy" && LIFTED_IN_ISLAND.has(item);
  const refuse = (item) => { if (reason === undefined && !liftable(item)) reason = item; };
  const visit = (node) => {
    if (reason !== undefined) return;
    if ((node.kind === ts.SyntaxKind.ThisKeyword && !hasOwnThisBinding(node)) ||
      node.kind === ts.SyntaxKind.ImportKeyword || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      refuse("host:script-environment");
    } else if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      refuse(`host:${node.text}`);
    } else if (ts.isIdentifier(node) && node.text === "arguments" &&
      (!argumentsOwner(node) ||
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === "length") &&
        !(ts.isElementAccessExpression(node.parent) && node.parent.expression === node))) {
      refuse("host:arguments");
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
            ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"].includes(parent.parent.arguments[0].text)))
      ) {
        // Supported assertion calls; aliases, mutations, and reflection stay out.
      } else refuse("harness:assert-surface");
    } else if (meta.includes.includes("compareArray.js") && ts.isIdentifier(node) && node.text === "compareArray" &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node && ts.isIdentifier(node.parent.expression) && node.parent.expression.text === "assert")) {
      // assert.js defines the bare compareArray; only its direct call form is
      // hosted (a value reference or property read would need the upstream
      // function object and its format expando).
      reason = "harness:compareArray-surface";
    } else if (ts.isIdentifier(node) && node.text === "Test262Error") {
      if (!ts.isNewExpression(node.parent) || node.parent.expression !== node) refuse("harness:Test262Error-surface");
    } else if (typedArrayHelper && ts.isIdentifier(node) && node.text === "TypedArray") {
      // The adapted testTypedArray.js leaves out %TypedArray%.
      refuse("harness:TypedArray-intrinsic");
    } else if (propertyHelper && ts.isIdentifier(node)) {
      if (unsupportedPropertyHelpers.has(node.text)) refuse("harness:propertyHelper-surface");
      else if (node.text === "verifyProperty") {
        const call = node.parent;
        if (!ts.isCallExpression(call) || call.expression !== node || call.arguments.length < 3 || !inlinePropertyDescriptor(call.arguments[2])) {
          refuse("harness:propertyHelper-surface");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reason;
}

export function prepare(source, asyncTest = false, marker = completion, variant = "strict", includes = []) {
  const names = asyncTest
    ? "assert, compareArray, Test262Error, $DONE"
    : "assert, compareArray, Test262Error";
  const end = asyncTest ? "" : `;console.log(${JSON.stringify(marker)});\n`;
  const helpers =
    (includes.includes("propertyHelper.js") ? `${propertyHelperSource}\n` : "") +
    (includes.includes("testTypedArray.js") ? `${typedArrayHelperSource}\n` : "");
  if (variant === "sloppy") return `const { ${names} } = require("./harness.ts");\n${helpers}${source}\n${end}`;
  return `"use strict";\nimport { ${names} } from "./harness.ts";\n${helpers}${source}\n${end}`;
}

// The adapted test of the island lane (decision S4). It runs under Node, so
// `assert` is a JavaScript object built there: a native function crosses the
// bridge as a callable, but the namespace members attached to it do not (they
// are properties of the native function object). The harness exports each
// helper on its own for exactly this.
//
// The body normally runs as the island module itself. A lifted
// `host:script-environment` variant keeps its script shape instead: the
// module carries the body between these markers only as a dead copy the
// pre-scan can island, and replays it as script code inside the island.
const scriptBegin = "//@@SCRIPTC_TEST262_SCRIPT_BEGIN@@";
const scriptEnd = "//@@SCRIPTC_TEST262_SCRIPT_END@@";

export function prepareIsland(source, asyncTest = false, marker = completion, includes = [], script = false) {
  const helpers =
    (includes.includes("propertyHelper.js") ? `${propertyHelperSource}\n` : "") +
    (includes.includes("testTypedArray.js") ? `${typedArrayHelperSource}\n` : "");
  const end = asyncTest ? "" : `;console.log(${JSON.stringify(marker)});\n`;
  const lines = [
    'const harness = require("./harness.ts");',
    "const assert = (value, message) => harness.assert(value, message);",
    "assert.sameValue = harness.sameValue;",
    "assert.notSameValue = harness.notSameValue;",
    "assert.throws = harness.assertThrows;",
    "assert.compareArray = harness.assertCompareArray;",
    "const compareArray = harness.compareArray;",
    "const Test262Error = harness.Test262Error;",
    ...(asyncTest ? ["const $DONE = harness.$DONE;"] : []),
  ];
  if (!script) return `${lines.join("\n")}\n${helpers}${source}\n${end}`;
  // A lifted `host:script-environment` variant is a script, not a module: its
  // top-level `this` is the global object and its top-level `var` bindings are
  // global properties. The island therefore replays the body as script code,
  // and the module carries it only as a dead copy the pre-scan can island.
  const globals = [
    "globalThis.assert = assert;",
    "globalThis.compareArray = compareArray;",
    "globalThis.Test262Error = Test262Error;",
    ...(asyncTest ? ["globalThis.$DONE = $DONE;"] : []),
  ];
  return [
    'const { readFileSync } = require("node:fs");',
    'const vm = require("node:vm");',
    ...lines,
    ...globals,
    `const begin = ${JSON.stringify(scriptBegin)};`,
    `const stop = ${JSON.stringify(scriptEnd)};`,
    'const text = readFileSync(__filename, "utf8");',
    // The markers also appear in the `begin`/`stop` definitions, so the body
    // is the last block that starts with the begin marker.
    "const from = text.lastIndexOf(begin);",
    "const to = text.indexOf(stop, from + begin.length);",
    'if (from < 0 || to < 0) throw new Error("the adapted script markers are missing");',
    `vm.runInThisContext(text.slice(from + begin.length, to) + ${JSON.stringify(end)}, { filename: __filename });`,
    "if (false) { (function () {",
    scriptBegin,
    `${helpers}${source}`,
    scriptEnd,
    "}); }",
  ].join("\n");
}

/** `host:script-environment` also covers ESM syntax; only a CommonJS-shaped
 * test can be replayed as a script inside its island. */
export function scriptEnvironment(source) {
  const sf = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return !ts.isExternalModule(sf);
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
  // `arguments` in a class field initializer or static block (ContainsArguments
  // of Initializer / ClassStaticBlockBody is a static-semantics early error;
  // the guard keeps the code for an ordinary unresolved name out).
  2304, 2662,
  // Grammar and early errors tsc reports as semantic diagnostics, one per line
  // with the specification rule each one stands for.
  1054, // a `get` accessor with formal parameters.
  1104, // `continue` outside an enclosing iteration statement.
  1105, // `break` outside an enclosing iteration or switch statement.
  1189, // a `for...in` head declaration with an initializer.
  1200, // a line terminator between the arrow parameters and `=>`.
  1210, // a class body is strict code (binding `eval`/`arguments`, legacy octal, `with`).
  1341, // a class constructor that is an accessor.
  1368, // a class constructor that is a generator.
  1451, // a private name outside a class body or outside a private reference.
  1492, // a `using` / `await using` declaration with a binding pattern.
  17013, // `new.target` outside any function (only global code, via the guard).
  18013, // a private name used outside the class that declares it.
  2335, // `super()` outside a derived-class constructor (older message form).
  2357, // an update operand that is not a valid assignment target.
  2405, // a `for...in` head whose left-hand side is not a valid assignment target.
  2481, // a `var` in a scope that also declares the same name with let/const/using.
  2660, // `super.x` outside any [[HomeObject]] member (older message form).
  2699, // a static member named `prototype`.
  5076, // `??` chained with `&&` / `||` without parentheses.
]);

// Several of those codes also describe a construct that is legal JavaScript
// elsewhere: the code is broader than the early error it names (a `static`
// member named `name` is legal, `super.x` in a base-class method is legal, a
// `for...in` head over a number-typed property is legal). A negative parse
// test passes only when the diagnostic's own site is the one the
// specification makes an early error, so those codes carry a site guard. A
// guard is deliberately conservative: an unrecognised site keeps the refusal.
const earlyErrorSites = new Map([
  [1189, forInInitializerIsEarlyError],
  [2405, forInTargetIsEarlyError],
  [2304, containsArgumentsIsEarlyError],
  [2662, containsArgumentsIsEarlyError],
  [17013, newTargetOutsideFunction],
  [2335, superCallOutsideDerivedConstructor],
  [2660, superPropertyOutsideHomeObject],
  [2699, staticPrototypeIsEarlyError],
  [1341, constructorMemberIsEarlyError],
  [1368, constructorMemberIsEarlyError],
  [2357, updateOperandIsEarlyError],
]);

/** The narrowest node whose span contains `position`, with its parents set. */
function smallestNodeAt(file, position) {
  let found;
  const visit = (node) => {
    if (position < node.getStart(file) || position >= node.end) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The class element the member name at `node` belongs to. */
function enclosingMember(node) {
  const element = node?.parent;
  return element && ts.isClassElement(element) ? element : undefined;
}

function memberNameText(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

// 1189: B.3.5 still allows `for (var binding = initializer in expr)` in sloppy
// code with a plain binding identifier. Every other for-in initializer is an
// early error.
function forInInitializerIsEarlyError(file, variant, diagnostic) {
  let list = smallestNodeAt(file, diagnostic.start);
  while (list && !ts.isVariableDeclarationList(list)) list = list.parent;
  if (!list) return true;
  const sloppyVar = variant === "sloppy" && (list.flags & ts.NodeFlags.BlockScoped) === 0 &&
    list.declarations.every((declaration) => ts.isIdentifier(declaration.name));
  return !sloppyVar;
}

// 2405: the left-hand side of a `for...in` head must be a valid assignment
// target. tsc also uses this code for a number-typed property target, which is
// legal JavaScript.
function forInTargetIsEarlyError(file, _variant, diagnostic) {
  let statement = smallestNodeAt(file, diagnostic.start);
  while (statement && !ts.isForInStatement(statement)) statement = statement.parent;
  if (!statement) return true;
  let target = statement.initializer;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  return !(ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target));
}

// 2662: `arguments` is an early error only in a class field initializer or a
// static block, including through nested arrows (ContainsArguments). A
// computed member name is evaluated in the enclosing scope, not in the
// initializer, so it stays out. The code itself is the checker's ordinary
// "cannot find name" report.
function containsArgumentsIsEarlyError(file, _variant, diagnostic) {
  let node = smallestNodeAt(file, diagnostic.start);
  if (!node || !ts.isIdentifier(node) || node.text !== "arguments") return false;
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isComputedPropertyName(parent)) return false;
    if (ts.isPropertyDeclaration(parent) || ts.isClassStaticBlockDeclaration(parent)) return true;
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

// 17013: `new.target` is an early error outside any function. A class field
// initializer and a static block are function-like for it, and so is an arrow,
// but a computed member name is evaluated in the enclosing scope.
function newTargetOutsideFunction(file, _variant, diagnostic) {
  const node = smallestNodeAt(file, diagnostic.start);
  for (let parent = node?.parent; parent; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isPropertyDeclaration(parent)) {
      const initializer = parent.initializer;
      if (initializer && diagnostic.start >= initializer.getStart(file) && diagnostic.start < initializer.end) return false;
      continue;
    }
    if (ts.isClassStaticBlockDeclaration(parent) || ts.isFunctionLike(parent)) return false;
  }
  return true;
}

// 2335: `super()` is an early error unless it is lexically inside the
// constructor of a class with a heritage clause. The same code also names a
// legal `super.x` in a base-class method, which is a property reference, not a
// call, so those sites stay out (a property reference outside every member is
// 2660's early error, guarded below).
function superCallOutsideDerivedConstructor(file, _variant, diagnostic) {
  const node = smallestNodeAt(file, diagnostic.start);
  if (!node || node.kind !== ts.SyntaxKind.SuperKeyword) return false;
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || call.expression !== node) return false;
  for (let child = call, parent = call.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isPropertyDeclaration(parent) || ts.isClassStaticBlockDeclaration(parent)) return true;
    if (ts.isFunctionLike(parent)) {
      if (!ts.isConstructorDeclaration(parent)) return true;
      const owner = parent.parent;
      return !(ts.isClassLike(owner) && (owner.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword));
    }
  }
  return true;
}

/** Whether a `super` reference ascends to a [[HomeObject]]: a class method,
 * accessor, constructor, field initializer or static block, an object-literal
 * method, or an arrow inside one of those whose own reference is legal. */
function superPropertyOutsideHomeObject(file, _variant, diagnostic) {
  let node = smallestNodeAt(file, diagnostic.start);
  for (let parent = node?.parent; parent; node = parent, parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isComputedPropertyName(parent)) return true;
    if (ts.isPropertyDeclaration(parent) || ts.isClassStaticBlockDeclaration(parent)) return false;
    if (ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) || ts.isConstructorDeclaration(parent)) {
      return !(ts.isClassLike(parent.parent) || ts.isObjectLiteralExpression(parent.parent));
    }
    if (ts.isFunctionLike(parent)) return true;
    if (ts.isClassLike(parent) || ts.isHeritageClause(parent)) return true;
  }
  return true;
}

// 2699: only a static member named `prototype` is an early error. A static
// member named `name`, `length`, `caller` or `arguments` is legal JavaScript.
function staticPrototypeIsEarlyError(file, _variant, diagnostic) {
  const element = enclosingMember(smallestNodeAt(file, diagnostic.start));
  if (!element) return false;
  if ((ts.getCombinedModifierFlags(element) & ts.ModifierFlags.Static) === 0) return false;
  return memberNameText(element.name) === "prototype";
}

// 1341 / 1368: a class constructor may not be an accessor or a generator. tsc
// reports both codes for a static member named `constructor` as well, and
// `static get constructor() {}` and `static *constructor() {}` are legal
// JavaScript, so those sites stay out.
function constructorMemberIsEarlyError(file, _variant, diagnostic) {
  const element = enclosingMember(smallestNodeAt(file, diagnostic.start));
  if (!element) return true;
  return (ts.getCombinedModifierFlags(element) & ts.ModifierFlags.Static) === 0;
}

// 2357: an update operator needs a variable or a property access as its
// operand. tsc also reports it for a call result such as `f()++`, which V8
// parses and only refuses at run time, with a ReferenceError, so a
// negative parse test must not take that site as its SyntaxError. Every other
// operand (a literal, an arithmetic result, a `new` expression) is refused
// while parsing, and so is an optional call, whose question mark stays on the
// call node.
function updateOperandIsEarlyError(file, _variant, diagnostic) {
  let node = smallestNodeAt(file, diagnostic.start);
  while (
    node &&
    !((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
  ) {
    node = node.parent;
  }
  if (!node) return true;
  let operand = node.operand;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  return !(ts.isCallExpression(operand) && operand.questionDotToken === undefined);
}

export function earlyErrorDiagnostics(source, variant) {
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
    !(variant === "sloppy" && (diagnostic.code === 1214 || diagnostic.code === 1215)) &&
    (earlyErrorSites.get(diagnostic.code)?.(file, variant, diagnostic) ?? true));
}

// The compiler's OWN early errors (frontend/early-errors.ts): static
// semantics tsc does not model, reported at preflight under their own codes.
// A negative-parse test only asks for SOME SyntaxError, so one of these
// inside the test's source is a match — the same standard as the tsc
// diagnostics above, minus tsc's ability to tell us where it points.
const ownEarlyErrorCodes = new Set([
  "SC0005",
  "SC0006",
  "SC0007",
  "SC0008",
  "SC0009",
  "SC0010",
]);

// tsc appends a "Did you mean ...?" suggestion to some of its messages, and the
// compiler under test may append it where tsc does not (or leave it out). The
// suggestion is an addendum to the same diagnostic, so the containment compares
// code, start and the message without it.
function messageCore(message) {
  return message.replace(/ Did you mean [^?]*\?$/, "");
}

export function matchesParseNegative(outcome, source, variant = "strict") {
  if (outcome.status !== "compile-refusal") return false;
  {
    const prepared = prepare(source, false, completion, variant);
    const start = prepared.indexOf(source);
    const end = start + source.length;
    const suffix = variant === "sloppy" ? "/main.cjs" : "/main.js";
    const own = outcome.diagnostics?.some(
      (reported) =>
        ownEarlyErrorCodes.has(reported.code) &&
        reported.loc?.file?.endsWith(suffix) &&
        reported.loc.start >= start &&
        reported.loc.start < end,
    );
    if (own) return true;
  }
  const matches = (parsed) => outcome.diagnostics?.some((reported) =>
    reported.code === "SC0001" &&
    reported.loc?.file?.endsWith(variant === "sloppy" ? "/main.cjs" : "/main.js") &&
    reported.loc.start === parsed.start &&
    messageCore(reported.message) === messageCore(ts.flattenDiagnosticMessageText(parsed.messageText, "\n")));
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
  // Decision S4: a variant whose entry module ran in a Node island passes
  // for the profile — it proved Node's semantics, which is what the
  // expectation asserts — but it stays a separate status, so the counts
  // never report it as a native pass.
  const status = outcome.status === "island-pass" ? "pass" : outcome.status;
  const expected = expectations[id];
  if (!expected) return status === "pass";
  return status === expected.status && outcome.reason === expected.reason &&
    outcome.stderr?.includes(expected.detail) === true;
}
