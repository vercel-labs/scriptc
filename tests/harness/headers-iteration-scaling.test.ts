/* `for..of` over a Headers' entries stays linear in the number of entries,
 * including repeated response headers that each keep their own entry (a
 * fetched response may carry a thousand set-cookie fields). The lowered
 * walk re-reads the live list on every pass, so the bound and every entry
 * must come from O(1) reads of the list the fetch unit already built:
 * walking the entries iterator once per pass, or replaying it once per
 * entry, multiplies the response size by itself. A small Headers' live
 * iteration is pinned by tests/corpus/fetch-headers-iteration.ts; this test
 * bounds how the walk grows with the list.
 *
 * The program times the loop itself, so the bound covers the walk and not
 * process startup or the header construction that precedes it. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");

/** A Headers of `entries` set-cookie fields, each its own entry of the
 * walk, and the count and total name-and-value bytes the loop prints. */
function program(entries: number): { source: string; expected: string } {
  let bytes = 0;
  for (let i = 0; i < entries; i++) bytes += "set-cookie".length + `k${i}=v`.length;
  const source = [
    `const headers = new Headers();`,
    `for (let i = 0; i < ${entries}; i++) headers.append("set-cookie", \`k\${i}=v\`);`,
    `let names = 0;`,
    `let bytes = 0;`,
    `const start = Date.now();`,
    `for (const [name, value] of headers.entries()) {`,
    `  names += 1;`,
    `  bytes += name.length + value.length;`,
    `}`,
    `console.log(names, bytes, Date.now() - start);`,
  ].join("\n");
  return { source: source + "\n", expected: `${entries} ${bytes}` };
}

test("iterating a Headers' entries is linear in the number of response headers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-headers-scaling-"));
  try {
    const run = async (entries: number): Promise<{ printed: string; ms: number }> => {
      const { source } = program(entries);
      const entry = join(dir, `walk${entries}.ts`);
      const binary = join(dir, `walk${entries}`);
      writeFileSync(entry, source);
      await execFileAsync(
        process.execPath,
        [join(repoRoot, "packages/cli/dist/main.js"), "build", entry, "-o", binary],
        { env: { ...process.env, SCRIPTC_NO_CACHE: "1" }, maxBuffer: 16 * 1024 * 1024 },
      );
      const { stdout } = await execFileAsync(binary, [], { encoding: "utf8" });
      const [names, bytes, ms] = stdout.trim().split(" ");
      return { printed: `${names} ${bytes}`, ms: Number(ms) };
    };
    expect((await run(250)).printed).toBe(program(250).expected);
    const large = await run(4000);
    expect(large.printed).toBe(program(4000).expected);
    // Sixteen times the entries. Recounting the list per pass and
    // replaying the iterator per entry took 7.5 s over 4000 entries; the
    // indexed reads answer both sizes in under a millisecond. The bound
    // leaves room for a sanitizer build on a slow runner.
    expect(large.ms, `${large.ms} ms over 4000 entries`).toBeLessThan(1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
