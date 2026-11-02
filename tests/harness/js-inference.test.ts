/* Shape inference for the program's own JavaScript (SCRIPTC_INFER_JS=1,
 * frontend/js-inference.ts): each corpus program below compiles with the
 * overlay on its own files and prints what Node prints, with Node's exit
 * code. Each covers a case where an inferred type used to be narrower than
 * the values the program holds. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const corpus = join(repoRoot, "tests/corpus");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/js-inference");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const programs = [
  // `+=` of a value that may be a string, and a union stored into a number binding.
  "7038-js-var-later-writes.mjs",
  "7054-let-bindings-with-null-writes.mjs",
  // `for await` over a sync iterable, and an iterable object literal with a computed key.
  "8380-untyped-generator-loops.mjs",
  // `matchAll` yields match arrays.
  "6011-match-metadata-js.js",
  // `at`, `codePointAt` and a number's `valueOf`.
  "inferred-builtin-method-results.js",
  "webassembly-wpt-jsapi.mjs",
  // Class instances reached by computed writes and property definitions.
  "7620-js-class-view-descriptors.js",
  // Overridden methods and getters whose results differ.
  "js-class-return-shapes.js",
  // The program's own JSDoc next to the overlay's.
  "class-instance-constructor.js",
  // A method called with a proxy as its receiver.
  "js-callable-proxy.js",
  // A constructor parameter stored into a field that later holds strings.
  "js-loose-dynamic-primitives.js",
  // A `__proto__: null` literal among a function's results.
  "object-literal-members.mjs",
  // A computed key read before the binding it names is initialized.
  "4090-computed-key-tdz.js",
  // Fields an instance may lack.
  "8410-dynamic-class-instance-reads.js",
  // Fields read before the constructor stores them.
  "inferred-field-before-assignment.js",
  // `+` and `+=` results by operand types.
  "inferred-plus-results.js",
  // Pattern elements past the end of the array they destructure.
  "inferred-partial-destructuring.mjs",
  // Module-level records and arrays typed by the overlay, shared by functions.
  "inferred-module-containers.mjs",
  // Bindings the overlay cannot type: their values stay dynamic.
  "5178-forin-keys-js.js",
  "inferred-record-return.mjs",
  "opentui-byte-queue.js",
  // A literal storing a parameter the program's JSDoc types.
  "js-inferred-object-values.js",
  // Functions called through an untyped member keep their arguments' identity.
  "weak-map-fresh-array.js",
  // Destructuring a typed union with null and several data arms.
  "destructure-untyped-source-null.js",
];

async function run(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; code: number }> {
  try {
    const child = execFileAsync(file, args, { cwd, encoding: "utf8" });
    child.child.stdin?.end();
    const { stdout } = await child;
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; code?: number };
    return { stdout: failed.stdout ?? "", code: failed.code ?? -1 };
  }
}

async function withInference<T>(build: () => Promise<T>): Promise<T> {
  const saved = process.env["SCRIPTC_INFER_JS"];
  process.env["SCRIPTC_INFER_JS"] = "1";
  try {
    return await build();
  } finally {
    if (saved === undefined) delete process.env["SCRIPTC_INFER_JS"];
    else process.env["SCRIPTC_INFER_JS"] = saved;
  }
}

test.each(programs)("%s matches Node with inference on", { timeout: 900_000 }, async (name) => {
  mkdirSync(outDir, { recursive: true });
  const entry = join(corpus, name);
  const out = join(outDir, name.replace(/\.m?js$/, ""));
  const result = await withInference(() => compile(entry, { outPath: out, outDir, sanitize }));
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  const [built, node] = await Promise.all([
    run(result.binaryPath, [], dirname(entry)),
    run(process.execPath, [entry], dirname(entry)),
  ]);
  // The overlay typed the program's own files.
  expect((result.warnings ?? []).some((w) => w.code === "SC6103")).toBe(true);
  expect(built.stdout).toBe(node.stdout);
  expect(built.code).toBe(node.code);
});
