/* A Promise.all entry whose value fails the check into its tuple position.
 *
 * scriptc-only, like dyncheck.test.ts: Node does not check the declared type
 * and fulfils with the value. The program is built outside node_modules
 * (unlike dyncheck's cache directory) because its entry is a value whose
 * declared type has no static lowering, which only program code may hold as
 * a checked-dynamic value. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test(`a Promise.all entry that fails its tuple position's check rejects the result${sanitize ? " (sanitized)" : ""}`, async () => {
  // The entry is a thenable whose declared type gives the tuple a number;
  // it resolves with a string. The conversion's TypeError rejects the
  // combined promise: the settlement used to fulfil with no tuple and crash.
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-promise-all-entry-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(
    entry,
    `
let reads = 0;
function make() {
  return {
    get then(): any {
      reads++;
      return reads === 1 ? (resolve: (v: any) => void) => { resolve("first read"); } : undefined;
    },
  };
}
function show(v: any): string {
  return v instanceof Error ? v.message : String(v);
}
const all = Promise.all([make()]);
all.then(
  (v) => { console.log("fulfilled", show(v)); },
  (e) => { console.log("rejected", e instanceof TypeError, show(e)); },
);
`,
  );
  const result = await compile(entry, {
    outPath: join(outDir, "main"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  expect(stdout).toBe("rejected true expected number at $, got string\n");
  expect(
    stderr.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext[^\n]*\n/gm, ""),
  ).toBe("");
});
