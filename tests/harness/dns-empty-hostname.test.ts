/* Node answers an empty dns hostname (the DEP0118 compatibility path) with
 * `null` as the address and the family it would have looked up. The typed
 * callback signature and the promise result declare the address as a
 * string, so the typed tiers cannot carry that null: the checked form
 * substitutes the empty string, the way a failed typed lookup substitutes
 * "" and NaN. These programs pin the substitution and the family. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const dir = mkdtempSync(join(tmpdir(), "scriptc-dns-empty-hostname-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(
  name: string,
  source: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = join(dir, `${name}.ts`);
  writeFileSync(entry, source);
  const result = await compile(entry, { outPath: join(dir, name), outDir: dir, sanitize });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return { code: -1, stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const failure = e as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("a typed lookup callback sees the empty address string and the answered family", async () => {
  const { code, stdout, stderr } = await run(
    "callback",
    `import * as dns from "node:dns";
dns.lookup("", (err, address, family) => {
  console.log(err, JSON.stringify(address), family, typeof address);
});
`,
  );
  expect(code).toBe(0);
  expect(stdout).toBe('null "" 4 string\n');
  expect(stderr).toContain("DEP0118");
});

test("a typed all lookup and a typed family-6 lookup answer the empty list and family", async () => {
  const { code, stdout } = await run(
    "callback-all",
    `import * as dns from "node:dns";
dns.lookup("", { all: true }, (err, addresses) => {
  console.log(err, addresses.length);
});
dns.lookup("", { family: 6 }, (err, address, family) => {
  console.log(err, JSON.stringify(address), family);
});
`,
  );
  expect(code).toBe(0);
  expect(stdout).toBe('null 0\nnull "" 6\n');
});

test("a typed promise lookup settles the empty address string and the family", async () => {
  const { code, stdout, stderr } = await run(
    "promise",
    `import * as dns from "node:dns/promises";
console.log(JSON.stringify(await dns.lookup("")));
console.log(JSON.stringify(await dns.lookup("", { family: 6 })));
console.log((await dns.lookup("", { all: true })).length);
`,
  );
  expect(code).toBe(0);
  expect(stdout).toBe('{"address":"","family":4}\n{"address":"","family":6}\n0\n');
  expect(stderr).toContain("DEP0118");
});
