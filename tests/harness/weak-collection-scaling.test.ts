/* WeakMap and WeakSet operations take expected constant time however many
 * keys a collection holds. Each lookup used to scan every entry of its
 * collection, so filling one with 200,000 keys took about a minute where
 * Node takes a tenth of a second (#1619). Behavior with many keys is
 * pinned by corpus 1619; this test bounds how the time of the same work
 * grows between two key counts. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);

// Sets, overwrites, gets, has checks and deletes on a WeakMap and a WeakSet
// that share n keys, then drops the keys. Prints the checksums, then the
// milliseconds the work took.
const source = `
const n = Number(process.argv[2]);
let keys: { id: number }[] = [];
for (let i = 0; i < n; i++) keys.push({ id: i });
const start = performance.now();
const map = new WeakMap<{ id: number }, number>();
const set = new WeakSet<{ id: number }>();
for (const key of keys) {
  map.set(key, key.id);
  set.add(key);
}
for (const key of keys) map.set(key, key.id * 2);
let sum = 0;
let members = 0;
for (const key of keys) {
  sum += map.get(key)!;
  if (set.has(key)) members++;
}
for (let i = 0; i < n; i += 2) {
  map.delete(keys[i]!);
  set.delete(keys[i]!);
}
for (const key of keys) {
  if (map.has(key)) sum++;
  if (set.has(key)) members--;
}
keys = [];
const elapsed = performance.now() - start;
console.log(sum, members);
console.log(elapsed);
`;

async function run(binary: string, n: number, timeout: number): Promise<number> {
  const { stdout } = await exec(binary, [String(n)], { encoding: "utf8", timeout });
  const [checksums, elapsed] = stdout.trimEnd().split("\n");
  expect(checksums).toBe(`${n * (n - 1) + n / 2} ${n / 2}`);
  return Number(elapsed);
}

test("weak collection operations take expected constant time as the key count grows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-weak-scaling-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const result = await compile(entry, {
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const small = await run(result.binaryPath, 25_000, 60_000);
    // Eight times the keys. Constant-time operations measured 12x to 15x
    // here (a larger working set misses cache more often); scanning every
    // entry measured 64x, and every doubling beyond adds 4x. The timeout
    // stops a quadratic run, which takes minutes at this size.
    const large = await run(result.binaryPath, 200_000, 60_000);
    expect(large / small, `${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`).toBeLessThan(32);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 300_000);
