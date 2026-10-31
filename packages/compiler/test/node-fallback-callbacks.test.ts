import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { checkPreflight, loadProgram } from "../src/frontend/program-node.js";
import type { IrExpr, IrFunction, IrModule } from "../src/ir/ir.js";
import { everyStmtList } from "../src/ir/traverse.js";

const exactTypes = `
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectType<T extends true>(): void;
`;

function preflight(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fallback-callbacks-"));
  try {
    writeFileSync(join(directory, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const entry = join(directory, "main.ts");
    writeFileSync(entry, exactTypes + source);
    const load = loadProgram(entry);
    try {
      expect(load.typeWorld?.nodeFallback).toBe(true);
      return checkPreflight(load);
    } finally {
      load.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const specifier of ["global", "process", "node:process"]) {
  const imported = specifier === "global" ? "" : 'import process from "' + specifier + '";\n';

  test(`fallback ${specifier} rejection listeners infer promises and unknown reasons`, () => {
    const calls = ["on", "once", "off", "removeListener"]
      .map(
        (method) => `
const unhandled_${method}: void = process.${method}("unhandledRejection", (reason, pending) => {
  expectType<Equal<typeof reason, unknown>>();
  expectType<Equal<typeof pending, Promise<unknown>>>();
  pending.then((value) => expectType<Equal<typeof value, unknown>>());
  pending.catch(() => {});
});
const handled_${method}: void = process.${method}("rejectionHandled", (pending) => {
  expectType<Equal<typeof pending, Promise<unknown>>>();
  pending.catch(() => {});
});
`,
      )
      .join("");
    expect(preflight(imported + calls)).toEqual([]);
  });

  test(`fallback ${specifier} exception listeners infer errors and origins`, () => {
    const calls = ["on", "once", "off", "removeListener", "prependListener"]
      .flatMap((method) =>
        ["uncaughtException", "uncaughtExceptionMonitor"].map(
          (event) => `
const ${event}_${method}: void = process.${method}("${event}", (error, origin) => {
  expectType<Equal<typeof error, Error>>();
  expectType<Equal<typeof origin, "uncaughtException" | "unhandledRejection">>();
  console.log(error.message, origin);
});
`,
        ),
      )
      .join("");
    expect(preflight(imported + calls)).toEqual([]);
  });

  test(`fallback ${specifier} rejection reasons still require narrowing`, () => {
    const diagnostics = preflight(
      imported +
        `process.on("unhandledRejection", (reason, pending) => {
  const message: string = reason;
  pending.catch(() => {});
  console.log(message);
});`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("SC0001");
    expect(diagnostics[0]?.message).toContain("Type 'unknown' is not assignable to type 'string'");
  });
}

for (const specifier of ["fs", "node:fs"]) {
  const imported = `import { stat, lstat, fstat, type Stats, type BigIntStats, type StatOptions } from "${specifier}";\n`;
  const members = [
    ["stat", '"."'],
    ["lstat", 'new URL("file:///tmp")'],
    ["fstat", "0"],
  ];

  test(`fallback ${specifier} stat callbacks infer option-selected snapshots`, () => {
    const calls = members
      .flatMap(([member, argument]) =>
        [
          ["", "Stats"],
          ["undefined, ", "Stats"],
          ["{ bigint: false }, ", "Stats"],
          ["{ bigint: true }, ", "BigIntStats"],
          ["options, ", "Stats | BigIntStats"],
        ].map(
          ([options, snapshot], index) => `
const ${member}_${index}: void = ${member}(${argument}, ${options}(error, stats) => {
  expectType<Equal<typeof error, NodeJS.ErrnoException | null>>();
  expectType<Equal<typeof stats, ${snapshot}>>();
  expectType<Equal<typeof stats.size, ${snapshot === "Stats" ? "number" : snapshot === "BigIntStats" ? "bigint" : "number | bigint"}>>();
});
`,
        ),
      )
      .join("");
    expect(
      preflight(
        imported + "const options: StatOptions = { bigint: process.argv.length > 0 };\n" + calls,
      ),
    ).toEqual([]);
  });

  test(`fallback ${specifier} stat callbacks reject the wrong numeric representation`, () => {
    const calls = members
      .flatMap(([member, argument]) => [
        `${member}(${argument}, (error, stats) => {
  if (error) throw error;
  const size: bigint = stats.size;
  console.log(size);
});`,
        `${member}(${argument}, { bigint: true }, (error, stats) => {
  if (error) throw error;
  const size: number = stats.size;
  console.log(size);
});`,
      ])
      .join("\n");
    const diagnostics = preflight(imported + calls);
    expect(diagnostics).toHaveLength(6);
    expect(diagnostics.every((diagnostic) => diagnostic.code === "SC0001")).toBe(true);
    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("Type 'number' is not assignable to type 'bigint'"),
      ),
    ).toHaveLength(3);
    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("Type 'bigint' is not assignable to type 'number'"),
      ),
    ).toHaveLength(3);
  });
}

async function lowered(source: string, extension = "ts", files: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fallback-callback-ir-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const entry = join(directory, `main.${extension}`);
    const outPath = join(directory, "main.ir.json");
    writeFileSync(entry, source);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    const load = loadProgram(entry);
    try {
      expect(load.typeWorld?.nodeFallback).toBe(true);
    } finally {
      load.dispose();
    }
    const result = await compile(entry, { outDir: directory, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return deserializeModule(readFileSync(outPath, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.for(["global", "process", "node:process"])(
  "fallback %s callback parameters lower through native process listeners",
  async (specifier) => {
    const imported = specifier === "global" ? "" : `import process from "${specifier}";\n`;
    const source = ["on", "once", "off", "removeListener"]
      .map(
        (method) => `
process.${method}("unhandledRejection", (reason, pending) => {
  pending.catch(() => console.log(typeof reason));
});
process.${method}("rejectionHandled", (pending) => {
  pending.catch(() => console.log("handled"));
});
`,
      )
      .join("");
    const exceptions = ["on", "once", "off", "removeListener", "prependListener"]
      .flatMap((method) =>
        ["uncaughtException", "uncaughtExceptionMonitor"].map(
          (event) =>
            `process.${method}("${event}", (error, origin) => console.log(error.message, origin));`,
        ),
      )
      .join("\n");
    const ir = JSON.stringify((await lowered(imported + source + exceptions)).functions);
    for (const operation of [
      "process.onUnhandledRejection",
      "process.offUnhandledRejection",
      "process.onRejectionHandled",
      "process.offRejectionHandled",
      "process.onUncaughtException",
      "process.offUncaughtException",
      "process.prependUncaughtException",
    ])
      expect(ir).toContain(`"fn":"${operation}"`);
  },
);

test.for(["fs", "node:fs"])(
  "fallback %s error-only stat callbacks lower through native filesystem calls",
  async (specifier) => {
    const calls = ["stat", "lstat", "fstat"]
      .flatMap((member) =>
        ["", "undefined, ", "{ bigint: false }, ", "{ bigint: true }, ", "options, "].map(
          (options) => `${member}(${member === "fstat" ? "0" : '"."'}, ${options}(error) => {
  if (error) console.log(error.message);
});`,
        ),
      )
      .join("\n");
    const ir = await lowered(
      `import { stat, lstat, fstat, type StatOptions } from "${specifier}";
const options: StatOptions = { bigint: process.argv.length > 0 };
${calls}
`,
    );
    expect(JSON.stringify(ir.functions)).toContain('"fn":"fs.callbackCall"');
  },
);

function expressions(fn: IrFunction): IrExpr[] {
  const result: IrExpr[] = [];
  everyStmtList(fn.body, {
    expr: (expr) => {
      result.push(expr);
      return true;
    },
    stmt: () => true,
  });
  return result;
}

function authoredFunction(mod: IrModule, source: string, name: string): IrFunction {
  const start = source.indexOf("function " + name + "(");
  expect(start).toBeGreaterThanOrEqual(0);
  const functions = mod.functions.filter(
    (fn) =>
      fn.loc.file === mod.sourceFile &&
      fn.loc.start === start &&
      fn.params.every((param) => param.type.kind !== "jsval"),
  );
  expect(functions).toHaveLength(1);
  return functions[0]!;
}

for (const [context, prefix, suffix] of [
  ["uncaughtException", 'process.on("uncaughtException", ', ");"],
  ["exit", 'process.on("exit", ', ");"],
  [
    "user-defined number",
    "/** @type {(value: number) => void} */\nconst callback = ",
    ";\ncallback(7);",
  ],
]) {
  test(`JavaScript contextual ${context} parameters stay dynamic when passed and logged`, async () => {
    const source = `
function forward(value) { console.log("forward", value); }
${prefix}function observe(value) {
  forward(value);
  console.log("value", value);
}${suffix}
`;
    const mod = await lowered(source, "cjs");
    const fn = authoredFunction(mod, source, "observe");
    expect(fn.params[0]?.type).toEqual({ kind: "dyn" });
    const reads = [
      source.indexOf("forward(value);") + "forward(".length,
      source.indexOf('console.log("value", value)') + 'console.log("value", '.length,
    ];
    for (const start of reads) {
      const atRead = expressions(fn).filter(
        (expr) =>
          expr.loc.file === mod.sourceFile &&
          expr.loc.start === start &&
          expr.loc.end === start + 5,
      );
      expect(atRead).toContainEqual(
        expect.objectContaining({
          kind: "varRef",
          localId: fn.params[0]!.localId,
          type: { kind: "dyn" },
        }),
      );
      expect(atRead.some((expr) => expr.kind === "dynCheck")).toBe(false);
    }
  });
}

test("JavaScript unknown callback parameters retain Error and string flow narrowing", async () => {
  const source = `
process.on("unhandledRejection", function narrowed(value) {
  if (value instanceof Error) console.log(value.message);
  if (typeof value === "string") console.log(value.length);
});
`;
  const mod = await lowered(source, "cjs");
  const fn = authoredFunction(mod, source, "narrowed");
  expect(fn.params[0]?.type).toEqual({ kind: "dyn" });
  for (const [read, type] of [
    ["value.message", { kind: "object", className: "%Error" }],
    ["value.length", { kind: "string" }],
  ] as const) {
    const start = source.indexOf(read);
    expect(expressions(fn)).toContainEqual(
      expect.objectContaining({
        kind: "dynCheck",
        type,
        loc: { file: mod.sourceFile, start, end: start + 5 },
        value: expect.objectContaining({ kind: "varRef", localId: fn.params[0]!.localId }),
      }),
    );
  }
});

test("JavaScript contextual Error callbacks keep an authored instanceof guard", async () => {
  const source = `
process.on("uncaughtException", function guarded(value) {
  console.log(value instanceof Error);
});
`;
  const mod = await lowered(source, "cjs");
  const fn = authoredFunction(mod, source, "guarded");
  const start = source.indexOf("value instanceof Error");
  expect(fn.params[0]?.type).toEqual({ kind: "dyn" });
  expect(expressions(fn)).toContainEqual(
    expect.objectContaining({
      kind: "dynTest",
      test: "error",
      loc: { file: mod.sourceFile, start, end: start + "value instanceof Error".length },
      value: expect.objectContaining({
        kind: "varRef",
        localId: fn.params[0]!.localId,
        type: { kind: "dyn" },
      }),
    }),
  );
});

for (const [event, typeName, type] of [
  ["uncaughtException", "Error", { kind: "object", className: "%Error" }],
  ["exit", "number", { kind: "f64" }],
] as const) {
  test(`JavaScript contextual ${event} parameters are checked by a typed ${typeName} consumer`, async () => {
    const source = `
const { consume } = require("./consumer");
process.on("${event}", function checked(value) {
  consume(value);
});
`;
    const mod = await lowered(source, "cjs", {
      "consumer.ts": `export function consume(value: ${typeName}): void { console.log(value); }`,
    });
    const fn = authoredFunction(mod, source, "checked");
    const consumers = mod.functions.filter(
      (candidate) =>
        candidate.loc.file === join(dirname(mod.sourceFile), "consumer.ts") &&
        candidate.sourceName === "consume" &&
        candidate.params.every((param) => param.type.kind !== "jsval"),
    );
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0]!;
    expect(consumer.params).toHaveLength(1);
    expect(consumer.params[0]).toMatchObject({ name: "value", type });
    const callStart = source.indexOf("consume(value)");
    const calls = expressions(fn).filter(
      (expr): expr is Extract<IrExpr, { kind: "call" }> =>
        expr.kind === "call" &&
        expr.callee === consumer.name &&
        expr.loc.file === mod.sourceFile &&
        expr.loc.start === callStart &&
        expr.loc.end === callStart + "consume(value)".length,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toHaveLength(1);
    const start = source.indexOf("consume(value)") + "consume(".length;
    expect(fn.params[0]?.type).toEqual({ kind: "dyn" });
    expect(calls[0]!.args[0]).toMatchObject({
      kind: "dynCheck",
      type,
      loc: { file: mod.sourceFile, start, end: start + 5 },
      value: { kind: "varRef", localId: fn.params[0]!.localId, type: { kind: "dyn" } },
    });
    expect(expressions(fn)).toContainEqual(
      expect.objectContaining({
        kind: "dynCheck",
        type,
        loc: { file: mod.sourceFile, start, end: start + 5 },
        value: expect.objectContaining({ kind: "varRef", localId: fn.params[0]!.localId }),
      }),
    );
  });
}

test.for(["fs", "node:fs"])(
  "fallback %s StatOptions aliases keep mutations on the shared option bag",
  async (specifier) => {
    const mod = await lowered(`
import { stat, lstat, fstat, type StatOptions as Options } from "${specifier}";
type LocalOptions = Options;
const original: LocalOptions = { bigint: false };
const alias = original;
alias.bigint = process.argv.length > 0;
stat(".", original, (error) => console.log(error === null));
lstat(".", alias, (error) => console.log(error === null));
fstat(0, original, (error) => console.log(error === null));
`);
    for (const name of ["original", "alias"])
      expect(mod.globals?.find((global) => global.name === name)?.type).toEqual({ kind: "dyn" });
    const nodes = mod.functions.flatMap(expressions);
    expect(
      nodes.filter((expr) => expr.kind === "libCall" && expr.fn === "fs.callbackCall"),
    ).toHaveLength(3);
    expect(nodes).toContainEqual(
      expect.objectContaining({
        kind: "libCall",
        fn: "dyn.keySet",
        args: expect.arrayContaining([
          expect.objectContaining({ kind: "strLit", value: "bigint" }),
        ]),
      }),
    );
  },
);

test("user StatOptions interfaces keep their native record representation", async () => {
  const source = `
interface StatOptions { bigint: number }
function read(options: StatOptions): number { return options.bigint + 1; }
console.log(read({ bigint: 41 }));
`;
  const mod = await lowered(source);
  const fn = authoredFunction(mod, source, "read");
  const type = fn.params[0]!.type;
  expect(type.kind).toBe("record");
  if (type.kind !== "record") throw new Error("user StatOptions lost its record type");
  expect(mod.records?.find((record) => record.id === type.shapeId)?.fields).toContainEqual(
    expect.objectContaining({ name: "bigint", type: { kind: "f64" } }),
  );
});
