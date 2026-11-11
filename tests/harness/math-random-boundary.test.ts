/* The line between Math.random and the secure random source — scriptc-only,
 * not differential (Node draws the same line inside V8, where no program
 * can see it).
 *
 * Math.random draws from a per-thread xorshift128+ generator that is seeded
 * once from the system's secure source (scr_math_random in scr_lib.c). It is
 * fast and predictable from a few outputs, as in Node. Everything node:crypto
 * and WebCrypto return (randomBytes, randomFill, randomInt, randomUUID,
 * getRandomValues, key generation) must come from the secure source on every
 * call and never from that generator. Two checks hold the line:
 *
 * - in the runtime sources, the generator's state is named only by the
 *   generator itself, and nothing in the runtime calls Math.random's entry;
 * - an executable that uses the crypto functions and not Math.random links
 *   no part of the generator and does link the secure source. The linker
 *   keeps only reachable functions, so a crypto path that reached the
 *   generator would keep its symbols in.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const runtimeSrc = join(repoRoot, "packages/runtime/src");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("only Math.random's own code names its generator", () => {
  const mentions: string[] = [];
  for (const name of readdirSync(runtimeSrc)) {
    if (!/\.[ch]$/.test(name) || name.endsWith(".test.c")) continue;
    readFileSync(join(runtimeSrc, name), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.includes("scr_math_random")) mentions.push(`${name}:${index + 1}: ${line.trim()}`);
      });
  }
  // The declaration compiled code calls, and the definition.
  const elsewhere = mentions.filter((m) => !/^(scr_lib\.c|scr_array\.h):/.test(m));
  expect(elsewhere, "runtime code outside the generator names scr_math_random").toEqual([]);
  expect(mentions.filter((m) => m.startsWith("scr_array.h:"))).toHaveLength(1);

  // Within scr_lib.c the names stay inside the generator: from the state's
  // declaration to the end of scr_math_random.
  const lib = readFileSync(join(runtimeSrc, "scr_lib.c"), "utf8").split("\n");
  const first = lib.findIndex((line) => line.includes("scr_math_random_state[2];"));
  const entry = lib.findIndex((line) => line.startsWith("double scr_math_random(void) {"));
  const last = lib.findIndex((line, index) => index > entry && line === "}");
  expect(first).toBeGreaterThan(0);
  expect(entry).toBeGreaterThan(first);
  expect(last).toBeGreaterThan(entry);
  const outside = lib
    .map((line, index) => ({ line, index }))
    // The comment above the Math statics describes the generator in prose.
    .filter(({ line }) => /scr_math_random(_state|_seed)?\b/.test(line) && !/^\s*\*/.test(line))
    .filter(({ index }) => index < first || index > last);
  expect(
    outside.map(({ line, index }) => `scr_lib.c:${index + 1}: ${line.trim()}`),
    "scr_lib.c names the generator outside scr_math_random",
  ).toEqual([]);
  // The generator takes its seed from the secure source, and nothing else.
  const body = lib.slice(first, last + 1).join("\n");
  expect(body.match(/arc4random_buf\(/g)).toHaveLength(1);
  expect(body).toMatch(/arc4random_buf\(scr_math_random_state, sizeof scr_math_random_state\)/);
});

async function build(name: string, source: string): Promise<{ binary: string; llvm: string }> {
  const outDir = join(cacheDir, `math-random-boundary-${name}${sanitize ? "-san" : ""}`);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, `${name}.ts`);
  writeFileSync(entry, source);
  const result = await compile(entry, {
    outPath: join(outDir, process.platform === "win32" ? "program.exe" : "program"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return { binary: result.binaryPath, llvm: readFileSync(result.llvmPath, "utf8") };
}

/** The symbol table of an executable, or null where no `nm` can read it. */
function symbols(binary: string): string | null {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  const nm = spawnSync("nm", [binary], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return nm.status === 0 ? nm.stdout : null;
}

const secureSource = `
import { getRandomValues, randomBytes, randomFillSync, randomInt, randomUUID, webcrypto } from "node:crypto";
const a = crypto.getRandomValues(new Uint8Array(32));
const b = getRandomValues(new Uint32Array(8));
const c = webcrypto.getRandomValues(new Uint16Array(8));
const d = randomBytes(32);
const e = randomFillSync(new Uint8Array(16));
const n = randomInt(1000);
console.log(a.length, b.length, c.length, d.length, e.length, n >= 0 && n < 1000);
console.log(randomUUID().length, crypto.randomUUID().length);
// 32 secure bytes are all zero with probability 2^-256.
console.log(a.some((x) => x !== 0), d.some((x) => x !== 0));
`;

test("the crypto random functions link the secure source and no part of Math.random", async () => {
  const { binary, llvm } = await build("secure", secureSource);
  expect(execFileSync(binary, [], { encoding: "utf8" })).toBe(
    "32 8 8 32 16 true\n36 36\ntrue true\n",
  );
  expect(llvm).not.toContain("scr_math_random");
  // Sanitized executables keep unreachable runtime code, so their symbol
  // table says nothing about what the program reaches.
  const table = sanitize ? null : symbols(binary);
  if (table === null) return;
  expect(table).not.toContain("scr_math_random");
  expect(table).toMatch(/\b_?(getrandom|arc4random_buf)\b/);
});

test("Math.random links its generator and none of the crypto entry points", async () => {
  const { binary, llvm } = await build(
    "fast",
    `let sum = 0;
for (let i = 0; i < 1000; i++) sum += Math.random();
console.log(sum > 0 && sum < 1000);
`,
  );
  expect(execFileSync(binary, [], { encoding: "utf8" })).toBe("true\n");
  expect(llvm).toMatch(/call double @scr_math_random\(\)/);
  expect(llvm).not.toMatch(/@scr_(crypto|webcrypto)_/);
  const table = sanitize ? null : symbols(binary);
  if (table === null) return;
  // Mach-O names carry a leading underscore.
  expect(table).toMatch(/\b_?scr_math_random_state\b/);
  // The generator's one secure draw is its seed.
  expect(table).toMatch(/\b_?(getrandom|arc4random_buf)\b/);
});
