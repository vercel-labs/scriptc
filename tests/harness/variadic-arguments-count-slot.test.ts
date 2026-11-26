/* The argument-count slot a variadic store uses for `arguments.length`.
 *
 * scriptc-only, like dyncheck.test.ts: the checks Node does not make are the
 * point. A call through the store whose typed argument fails its conversion
 * throws a checked TypeError before the call; the failed call must not leave
 * its count in the slot, which a later direct call would read as its own
 * arity. The zero-argument call is pinned by the differential corpus
 * (tests/corpus/variadic-arguments-store.ts), where Node agrees. */
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

test(`a rejected argument leaves no count for a later direct call${sanitize ? " (sanitized)" : ""}`, async () => {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-argc-slot-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(
    entry,
    `
function typed(a: string, b: number): void {
  console.log("typed", a, b, arguments.length);
}
const asRest: (...args: any[]) => void = typed;
try {
  asRest("x", "not-a-number");
  console.log("no throw");
} catch (e) {
  console.log("rejected", e instanceof TypeError);
}
typed("y", 2);
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
  expect(stdout).toBe("rejected true\ntyped y 2 2\n");
  expect(
    stderr.replace(/^==\d+==WARNING: ASan doesn't fully support makecontext[^\n]*\n/gm, ""),
  ).toBe("");
});
