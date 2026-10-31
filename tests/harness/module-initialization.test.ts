import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const cases = [
  { extension: "cjs", graph: false, esm: false },
  { extension: "cjs", graph: true, esm: false },
  { extension: "cts", graph: false, esm: false },
  { extension: "cts", graph: true, esm: false },
  { extension: "mjs", graph: false, esm: true },
  { extension: "mts", graph: false, esm: true },
  { extension: "cts", graph: false, esm: false, numeric: true },
  { extension: "cts", graph: true, esm: false, numeric: true },
];

for (const { extension, graph, esm, numeric = false } of cases) {
  const name = `failed module evaluation preserves ${extension} caching (metadata=${graph}, numeric=${numeric})`;
  test(
    name,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-module-retry-"));
      try {
        const loadModule = esm ? "await import" : "require";
        // Keep the loader in JavaScript: typed payloads exercise their module
        // guards without requiring TypeScript require-expression support.
        const entryName = esm ? "main.mjs" : "main.cjs";
        const loadFailed = `${loadModule}("./failed.${extension}")`;
        const loadSuccess = `${loadModule}("./ok.${extension}")`;
        const numbers = numeric
          ? `
function step(x: number, n: number): number { return (x * 31 + n) % 1000003; }
let value = 1;
for (let r = 0; r < 3; r++) for (let n = 0; n < 1000; n++) value = step(value, n);
let fraction = 0.5;
fraction += 0.25;
let signed = -1;
signed -= 1;
let unsigned = 2147483648;
unsigned += 1;
let zero = -0;
let nan = NaN;
const bytes = new Uint8Array([3, 4]);
console.log("numbers", value, fraction, signed, unsigned, Object.is(zero, -0), Number.isNaN(nan), bytes[0] + bytes[1]);
`
          : "";
        const files = {
          [entryName]: `${graph ? "void require.cache;\n" : ""}for (let i = 0; i < 2; i++) {
  try { ${loadFailed}; }
  catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
}
${loadSuccess};
${loadSuccess};
console.log("done");
`,
          [`failed.${extension}`]: numbers + 'console.log("failed");\nthrow new Error("retry");\n',
          [`ok.${extension}`]: `const value${extension.endsWith("ts") ? ": number" : ""} = 7;
console.log("ok", value);
`,
        };
        for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);
        const entry = join(dir, entryName);
        const expected = await execFileAsync(process.execPath, [entry], { encoding: "utf8" });
        const failure =
          (numeric ? "numbers 673909 0.75 -2 2147483649 true true 7\n" : "") + "failed\nretry\n";
        expect(expected.stdout).toBe(failure + (esm ? "retry\n" : failure) + "ok 7\ndone\n");
        expect(expected.stderr).toBe("");
        const result = await compile(entry, {
          outPath: join(dir, "program"),
          outDir: dir,
          sanitize,
        });
        if (!result.ok)
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const actual = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
        expect(actual.stdout).toBe(expected.stdout);
        // Match the differential harness's sole ASan context-switch warning normalization.
        const stderr = sanitize
          ? actual.stderr.replace(
              /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
              "",
            )
          : actual.stderr;
        expect(stderr).toBe(expected.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
}
