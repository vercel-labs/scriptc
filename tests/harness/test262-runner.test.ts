import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { boundedRun } from "../test262/execute.js";
import {
  chapterOf,
  limitPerChapter,
  parseStatuses,
  readJournalIds,
  readPathList,
  resolveListedPaths,
} from "../test262/select.mjs";
import {
  compileFailureStatus,
  directory,
  exclusion,
  matchesParseNegative,
  metadata,
  prepare,
  prepareIsland,
  scriptEnvironment,
  summarize,
  variants,
} from "../test262/support.mjs";

const source = (yaml: string, body = "assert.sameValue(1, 1);") => `/*---\n${yaml}\n---*/\n${body}`;

test("Test262 YAML metadata handles block text, lists, features and negative phases", () => {
  const meta = metadata(
    source(`description: >
  flags: [noStrict] inside a description is not a flag
flags:
  - onlyStrict
features: [BigInt]
includes: [propertyHelper.js]
negative:
  phase: parse
  type: SyntaxError`),
  );
  expect(meta.flags).toEqual(["onlyStrict"]);
  expect(meta.negative).toEqual({ phase: "parse", type: "SyntaxError" });
  expect(meta.features).toEqual(["BigInt"]);
  expect(meta.includes).toEqual(["propertyHelper.js"]);
});

test("metadata generates the upstream variants without rewriting execution goals", () => {
  expect(variants(metadata(source("description: plain")))).toEqual(["sloppy", "strict"]);
  for (const [flag, expected] of [
    ["onlyStrict", "strict"],
    ["noStrict", "sloppy"],
    ["module", "module"],
    ["raw", "raw"],
  ]) {
    expect(variants(metadata(source(`flags: [${flag}]`)))).toEqual([expected]);
  }
  expect(() => metadata(source("flags: [onlyStrict, noStrict]"))).toThrow();
  expect(variants(metadata(source("flags: [module, raw]")))).toEqual(["module"]);
  expect(() => metadata(source("flags: [futureFlag]"))).toThrow();
  expect(() => metadata(source("negative: {phase: compile, type: SyntaxError}"))).toThrow();
});

test("unsupported execution requirements and assertion reflection remain exclusions", () => {
  for (const [head, body] of [
    ["negative: {phase: runtime, type: TypeError}", "throw new TypeError();"],
    ["includes: [propertyHelper.js]", "verifyWritable({}, 'x');"],
    ["description: global script", "assert.sameValue(this, globalThis);"],
    ["description: reflection", "assert.sameValue(typeof assert, 'function');"],
    ["description: mutation", "assert.sameValue = () => {};"],
    ["description: unsupported helper", "assert.throws(CustomError, () => {});"],
  ]) {
    const text = source(head!, body);
    expect(exclusion(text, metadata(text), "strict")).toBeTypeOf("string");
  }
  const text = source(
    "description: scalar",
    "// globalThis and this in comments are harmless\nassert.sameValue('this', 'this');",
  );
  expect(exclusion(text, metadata(text), "strict")).toBeUndefined();
  expect(exclusion(text, metadata(text), "sloppy")).toBeUndefined();
  const scriptGlobal = source(
    "description: script global",
    "assert.sameValue((function () { return this; })(), globalThis);",
  );
  expect(exclusion(scriptGlobal, metadata(scriptGlobal), "sloppy")).toBe("host:globalThis");
  const commonJsGlobal = source(
    "description: CommonJS global",
    "assert.sameValue(module.exports, {});",
  );
  expect(exclusion(commonJsGlobal, metadata(commonJsGlobal), "sloppy")).toBe("host:module");
  const asyncText = source("flags: [async]", "Promise.resolve().then(() => $DONE());");
  expect(exclusion(asyncText, metadata(asyncText), "strict")).toBeUndefined();
});

test("the island lane lifts only the five host exclusions, on sloppy variants", () => {
  const globalRead = source(
    "description: global",
    "assert.sameValue(typeof globalThis, 'object');",
  );
  expect(exclusion(globalRead, metadata(globalRead), "sloppy")).toBe("host:globalThis");
  expect(exclusion(globalRead, metadata(globalRead), "sloppy", true)).toBeUndefined();
  // Strict variants stay in the native profile: the lane adds none.
  expect(exclusion(globalRead, metadata(globalRead), "strict", true)).toBe("host:globalThis");
  for (const [description, body] of [
    ["eval", "assert.sameValue(eval('1 + 1'), 2);"],
    ["Function", "assert.sameValue(Function('return 1')(), 1);"],
    ["arguments", "function f() { return arguments; } assert.sameValue(f(1).length, 1);"],
    ["script this", "assert.sameValue(this, undefined);"],
  ]) {
    const text = source(`description: ${description}`, body!);
    expect(exclusion(text, metadata(text), "sloppy"), body).toBeTypeOf("string");
    expect(exclusion(text, metadata(text), "sloppy", true), body).toBeUndefined();
  }
  // Harness limits and `$262` stay excluded even when the file also uses a
  // lifted construct, and a CommonJS-specific name is not a host reason.
  const helper = source("includes: [propertyHelper.js]", "verifyWritable({}, 'x'); eval('1');");
  expect(exclusion(helper, metadata(helper), "sloppy", true)).toBe(
    "harness:propertyHelper-surface",
  );
  const commonJsGlobal = source(
    "description: CommonJS global",
    "assert.sameValue(module.exports, {});",
  );
  expect(exclusion(commonJsGlobal, metadata(commonJsGlobal), "sloppy", true)).toBe("host:module");
});

test("a lifted script-environment variant keeps the script shape inside its island", () => {
  const script = source("description: script this", "this.value = 1;\nassert.sameValue(value, 1);");
  expect(scriptEnvironment(script)).toBe(true);
  const text = prepareIsland(script, false, "MARK", [], true);
  // The harness is installed on the global object, and the module only carries
  // a dead copy of the body so the pre-scan still islands the module.
  expect(text).toContain("globalThis.assert = assert;");
  expect(text).toContain("globalThis.Test262Error = Test262Error;");
  expect(text).toContain('const { readFileSync } = require("node:fs");');
  expect(text).toContain('const vm = require("node:vm");');
  expect(text).toContain("vm.runInThisContext(text.slice(from + begin.length, to)");
  expect(text).toContain("if (false) { (function () {");
  expect(text).toContain("this.value = 1;");
  // The ordinary island adaptation still runs the body as module code.
  expect(prepareIsland(script, false, "MARK", [])).not.toContain("vm.runInThisContext");
  // `host:script-environment` also names ESM syntax, which cannot be replayed
  // as a script.
  expect(scriptEnvironment("export default 1;")).toBe(false);
});

test("the harness declares each name once and exports every name the island prelude reads", () => {
  const file = join(directory, "harness.ts");
  const program = ts.createProgram([file], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
  });
  const sf = program.getSourceFile(file)!;
  // Duplicate identifier, redeclared block-scoped variable or export, and
  // duplicate function implementation: each fails every executable variant.
  const duplicates = program
    .getSemanticDiagnostics(sf)
    .filter((d) => [2300, 2323, 2393, 2451].includes(d.code))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(duplicates).toEqual([]);
  const checker = program.getTypeChecker();
  const exported = new Set(
    checker.getExportsOfModule(checker.getSymbolAtLocation(sf)!).map((symbol) => symbol.name),
  );
  const prelude = prepareIsland(source("description: names"), true, "MARK", [], true);
  const read = [...prelude.matchAll(/(?<![./\w])harness\.([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1]!,
  );
  expect(read.length).toBeGreaterThan(0);
  expect(read.filter((name) => !exported.has(name))).toEqual([]);
  // The bare compareArray and the assertion are different functions.
  expect(prelude).toContain("assert.compareArray = harness.assertCompareArray;");
  expect(prelude).toContain("const compareArray = harness.compareArray;");
  expect(prelude).toContain("globalThis.compareArray = compareArray;");
});

test("the property helper only admits direct inline descriptor checks", () => {
  for (const body of [
    "verifyProperty({}, 'x', { value: 1, configurable: false });",
    "verifyProperty({}, 'x', undefined);",
  ]) {
    const text = source("includes: [propertyHelper.js]", body);
    expect(exclusion(text, metadata(text), "strict")).toBeUndefined();
    expect(prepare(text, false, undefined, "strict", ["propertyHelper.js"])).toContain(
      "function verifyProperty(",
    );
  }
  for (const body of [
    "verifyProperty({}, 'x', descriptor);",
    "verifyProperty({}, 'x', { [key]: 1 });",
    "verifyProperty({}, 'x', { extra: 1 });",
    "const check = verifyProperty;",
    "verifyNotWritable({}, 'x');",
  ]) {
    const text = source("includes: [propertyHelper.js]", body);
    expect(exclusion(text, metadata(text), "strict")).toBe("harness:propertyHelper-surface");
  }
});

test("the typed array helper is admitted without the %TypedArray% intrinsic", () => {
  const text = source(
    "includes: [testTypedArray.js]",
    "testWithTypedArrayConstructors(function(TA) { assert.sameValue(new TA(1).length, 1); });",
  );
  expect(exclusion(text, metadata(text), "strict")).toBeUndefined();
  const prepared = prepare(text, false, undefined, "strict", ["testTypedArray.js"]);
  expect(prepared).toContain("function testWithTypedArrayConstructors(");
  expect(prepared).not.toContain("Object.getPrototypeOf(Int8Array)");
  for (const body of [
    "assert.sameValue(typeof TypedArray, 'function');",
    "testWithTypedArrayConstructors(function(TA) { assert.sameValue(Object.getPrototypeOf(TA), TypedArray); });",
  ]) {
    const named = source("includes: [testTypedArray.js]", body);
    expect(exclusion(named, metadata(named), "strict")).toBe("harness:TypedArray-intrinsic");
  }
  const other = source("includes: [testTypedArray.js, detachArrayBuffer.js]");
  expect(exclusion(other, metadata(other), "strict")).toBe("harness-includes:detachArrayBuffer.js");
});

test("receiver-bound this is admitted without adapting script-level this", () => {
  for (const [body, expected] of [
    ["class C { read() { return this.value; } }", undefined],
    ["class C { read() { return () => this.value; } }", undefined],
    ["class C { value = this; }", undefined],
    ["class C { static { this.value = 1; } }", undefined],
    ["function read() { return this; }", undefined],
    ["const read = () => this;", "host:script-environment"],
    ["assert.sameValue(this, undefined);", "host:script-environment"],
    ["class C { [this.key]() {} }", "host:script-environment"],
    ["class C extends this.Base {}", "host:script-environment"],
  ] as const) {
    const text = source("description: this binding", body);
    for (const variant of ["strict", "sloppy"] as const) {
      expect(exclusion(text, metadata(text), variant), `${variant}: ${body}`).toBe(expected);
    }
  }
});

test("arguments reads are admitted only for indexed and length access inside a function", () => {
  for (const [body, expected] of [
    [
      "function f() { return arguments.length === 1 && arguments[0] === 3; } assert(f(3));",
      undefined,
    ],
    ["function f() { return arguments; }", "host:arguments"],
    ["function f() { return Array.isArray(arguments); }", "host:arguments"],
    ["assert.sameValue(arguments.length, 0);", "host:arguments"],
  ]) {
    const text = source("description: arguments", body!);
    expect(exclusion(text, metadata(text), "strict")).toBe(expected);
  }
});

test("negative parse cases require the compiler's matching source diagnostic", () => {
  const text = source(
    "negative: {phase: parse, type: SyntaxError}",
    "$DONOTEVALUATE();\nconst = ;",
  );
  expect(exclusion(text, metadata(text), "strict")).toBeUndefined();
  expect(exclusion(text, metadata(text), "sloppy")).toBeUndefined();
  const offset = prepare(text).indexOf("const = ;") + "const ".length;
  const match = {
    status: "compile-refusal",
    diagnostics: [
      {
        code: "SC0001",
        message: "Variable declaration expected.",
        loc: { file: "/tmp/main.js", start: offset },
      },
    ],
  };
  expect(matchesParseNegative(match, text)).toBe(true);
  expect(matchesParseNegative(match, text, "sloppy")).toBe(false);
  const sloppyOffset =
    prepare(text, false, undefined, "sloppy").indexOf("const = ;") + "const ".length;
  expect(
    matchesParseNegative(
      {
        status: "compile-refusal",
        diagnostics: [
          {
            code: "SC0001",
            message: "Variable declaration expected.",
            loc: { file: "/tmp/main.cjs", start: sloppyOffset },
          },
        ],
      },
      text,
      "sloppy",
    ),
  ).toBe(true);
  expect(
    matchesParseNegative(
      {
        status: "compile-refusal",
        diagnostics: [
          {
            code: "SC0001",
            message: "Cannot find name '$DONOTEVALUATE'.",
            loc: { file: "/tmp/main.js", start: 0 },
          },
        ],
      },
      text,
    ),
  ).toBe(false);
  expect(
    matchesParseNegative({ status: "compiler-error", diagnostics: match.diagnostics }, text),
  ).toBe(false);
  const strictOnly = source("negative: {phase: parse, type: SyntaxError}", "with ({}) {}");
  expect(exclusion(strictOnly, metadata(strictOnly), "sloppy")).toBeUndefined();
  const generatedOnly = source("negative: {phase: parse, type: SyntaxError}", "function f() {");
  expect(exclusion(generatedOnly, metadata(generatedOnly), "strict")).toBeUndefined();
  const typeOnly = source("negative: {phase: parse, type: SyntaxError}", "const value = 'a' * 2;");
  const typeOffset = prepare(typeOnly).indexOf("'a' * 2");
  expect(
    matchesParseNegative(
      {
        status: "compile-refusal",
        diagnostics: [
          {
            code: "SC0001",
            message:
              "An arithmetic operand must be of type 'any', 'number', 'bigint' or an enum type.",
            loc: { file: "/tmp/main.js", start: typeOffset },
          },
        ],
      },
      typeOnly,
    ),
  ).toBe(false);
});

test("built-in error assertions are admitted without permitting constructor aliases", () => {
  for (const name of ["TypeError", "ReferenceError", "EvalError", "URIError"]) {
    const accepted = source(
      "description: exact error",
      `assert.throws(${name}, () => { throw new ${name}(); });`,
    );
    expect(exclusion(accepted, metadata(accepted), "strict")).toBeUndefined();
  }
  const alias = source(
    "description: custom error",
    "const Expected = TypeError; assert.throws(Expected, () => { throw new TypeError(); });",
  );
  expect(exclusion(alias, metadata(alias), "strict")).toBe("harness:assert-surface");
});

test("the compareArray include admits the assertion and the bare call form only", () => {
  const accepted = source(
    "includes: [compareArray.js]",
    "assert.compareArray([1, NaN], [1, NaN]);",
  );
  expect(exclusion(accepted, metadata(accepted), "strict")).toBeUndefined();
  const globalHelper = source("includes: [compareArray.js]", "compareArray([1], [1]);");
  expect(exclusion(globalHelper, metadata(globalHelper), "strict")).toBeUndefined();
  // assert.js supplies compareArray, so a test needs no include to call it.
  const withoutInclude = source("description: intl", "assert(!compareArray([1], [2]));");
  expect(exclusion(withoutInclude, metadata(withoutInclude), "strict")).toBeUndefined();
  const valueReference = source(
    "includes: [compareArray.js]",
    "const compare = compareArray; assert(compare([1], [1]));",
  );
  expect(exclusion(valueReference, metadata(valueReference), "strict")).toBe(
    "harness:compareArray-surface",
  );
});

test("the adapter retains the test body without a function or try/catch wrapper", () => {
  const body = source("description: lexical", "const x = 1;\nassert.sameValue(x, 1);");
  const result = prepare(body);
  expect(result.startsWith('"use strict";\n')).toBe(true);
  expect(result).toContain(`\n${body}\n`);
  expect(result).not.toContain("try {");
  const sloppy = prepare(body, false, "done", "sloppy");
  expect(sloppy).toContain(`\n${body}\n`);
  expect(sloppy).not.toContain('"use strict";');
});

test("reports keep exclusions, refusals, failures and passes separate", () => {
  expect(
    summarize([
      { status: "pass" },
      { status: "compile-refusal" },
      { status: "fail" },
      { status: "excluded", reason: "execution:sloppy" },
      { status: "excluded", reason: "execution:sloppy" },
    ]),
  ).toEqual({
    counts: { pass: 1, "compile-refusal": 1, fail: 1, excluded: 2 },
    exclusions: { "execution:sloppy": 2 },
  });
});

test("internal compiler failures cannot be classified as intentional refusals", () => {
  for (const code of ["SC0004", "SC9001", "SC9002"]) {
    expect(compileFailureStatus([{ code, loc: { file: "/tmp/harness.ts" } }])).toBe(
      "compiler-error",
    );
  }
  for (const code of ["SC3003", "SC3004"])
    expect(compileFailureStatus([{ code }])).toBe("build-error");
  for (const code of ["SC2020", "SC3001", "SC3002"])
    expect(compileFailureStatus([{ code }])).toBe("compile-refusal");
  expect(compileFailureStatus([{ code: "SC2020", loc: { file: "/tmp/harness.ts" } }])).toBe(
    "harness-refusal",
  );
});

test("a stuck process is killed and reported as a timeout", async () => {
  const result = await boundedRun(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100);
  expect(result.timeout).toBe(true);
  expect(result.code).not.toBe(0);
});

test("a path list selects exactly the listed tests, tolerating path spellings", () => {
  const inventory = [
    "test/built-ins/DataView/getUint8/a.js",
    "test/built-ins/DataView/getUint8/b.js",
    "test/language/expressions/addition/S11.6.1_A4_T1.js",
  ];
  expect(chapterOf(inventory[0]!)).toBe("test/built-ins/DataView");
  expect(chapterOf(inventory[2]!)).toBe("test/language/expressions");
  const list = readPathList(`
    # a comment
    test/built-ins/DataView/getUint8/a.js

    ./test/built-ins/DataView/getUint8/b.js
    /vercel/sandbox/snap/test/language/expressions/addition/S11.6.1_A4_T1.js
  `);
  expect(list).toEqual([
    "test/built-ins/DataView/getUint8/a.js",
    "test/built-ins/DataView/getUint8/b.js",
    "test/language/expressions/addition/S11.6.1_A4_T1.js",
  ]);
  expect([...resolveListedPaths(list, inventory)].sort()).toEqual(inventory);
  expect([...resolveListedPaths(["built-ins/DataView/getUint8/a.js"], inventory)]).toEqual([
    "test/built-ins/DataView/getUint8/a.js",
  ]);
  expect(() => resolveListedPaths(["test/built-ins/DataView/missing.js"], inventory)).toThrow(
    /unknown \(1\): test\/built-ins\/DataView\/missing.js/,
  );
  expect(() => resolveListedPaths(["DataView/getUint8/a.js"], inventory)).not.toThrow();
});

test("a path list refuses ambiguous short paths and unknown entries", () => {
  const inventory = ["test/built-ins/Array/same.js", "test/built-ins/Object/same.js"];
  expect(() => resolveListedPaths(["same.js"], inventory)).toThrow(/ambiguous/);
  expect(() => resolveListedPaths(["built-ins/Array/same.js"], inventory)).not.toThrow();
});

test("the per-chapter limit caps each chapter and spreads the sample", () => {
  const paths = Array.from({ length: 10 }, (_, index) => `test/built-ins/DataView/f${index}.js`);
  paths.push("test/built-ins/Object/o.js");
  const limited = limitPerChapter(paths, 4);
  expect(limited.filter((path) => chapterOf(path) === "test/built-ins/DataView")).toEqual([
    "test/built-ins/DataView/f0.js",
    "test/built-ins/DataView/f3.js",
    "test/built-ins/DataView/f6.js",
    "test/built-ins/DataView/f9.js",
  ]);
  expect(limited).toContain("test/built-ins/Object/o.js");
  expect(limitPerChapter(paths, 100)).toEqual(paths);
  expect(limitPerChapter(paths, 1)).toEqual([
    "test/built-ins/DataView/f0.js",
    "test/built-ins/Object/o.js",
  ]);
});

test("a journal replay selects the unexpected outcomes by default", () => {
  const journal = [
    { id: "test/a.js#strict", status: "pass" },
    { id: "test/b.js#strict", status: "fail" },
    { id: "test/b.js#sloppy", status: "runtime-refusal" },
    { id: "test/c.js#strict", status: "excluded" },
    { id: "test/b.js#strict", status: "fail" },
    { id: "test/d.js#strict", status: "compile-refusal" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  expect(parseStatuses(undefined)).toContain("fail");
  expect(parseStatuses(undefined)).not.toContain("pass");
  expect(parseStatuses(undefined)).not.toContain("excluded");
  expect([...readJournalIds(journal, parseStatuses(undefined))]).toEqual([
    "test/b.js#strict",
    "test/b.js#sloppy",
    "test/d.js#strict",
  ]);
  expect([...readJournalIds(journal, parseStatuses(["fail,runtime-refusal"]))]).toEqual([
    "test/b.js#strict",
    "test/b.js#sloppy",
  ]);
  expect([...readJournalIds(journal, parseStatuses(["pass"]))]).toEqual(["test/a.js#strict"]);
  expect(() => parseStatuses(["fixes"])).toThrow(/must name runner outcomes/);
  expect(() => readJournalIds("not json\n", parseStatuses(undefined))).toThrow(/not JSON/);
  expect(() => readJournalIds('{"id":"test/a.js#strict"}\n', parseStatuses(undefined))).toThrow(
    /no string id and status/,
  );
});
