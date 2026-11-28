/* A thenable behind a dynamic Promise.race entry. Node adopts it through
 * PromiseResolve; the dynamic resolve path does not model that adoption yet,
 * so the entry REFUSES by name instead of settling the race with the thenable
 * object as if it were the winner. This cannot be a corpus program: under
 * Node the adopted value wins there. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(
  import.meta.dirname,
  "../../node_modules/.cache/scriptc-tests/promise-race-dyn-thenable",
);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const REFUSAL = "Promise.race over a dynamic entry that holds a thenable is not supported yet";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function buildAndRun(name: string, source: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-race-dyn-${name}-`));
  try {
    mkdirSync(outDir, { recursive: true });
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const outPath = join(outDir, name);
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    try {
      const { stdout, stderr } = await execFileAsync(outPath, [], { encoding: "utf8" });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof e.code !== "number") throw err;
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a dynamic race entry holding a thenable refuses by name, not with a wrong winner", async () => {
  const result = await buildAndRun(
    "thenable",
    `async function main(): Promise<void> {
  const thenable: unknown = {
    then(resolve: (value: string) => void) {
      resolve("adopted");
    },
  };
  try {
    const winner = await Promise.race([
      thenable,
      new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 25)),
    ]);
    console.log("winner", winner);
  } catch (error) {
    const refused = error as Error & { code?: string };
    console.log("refused", refused.message, refused.code);
  }
}
main();
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(`refused ${REFUSAL} SC1090`);
  expect(result.stdout).not.toContain("winner");
  expect(result.stdout).not.toContain("adopted");
});

test("a dynamic race entry holding a plain value still wins", async () => {
  const result = await buildAndRun(
    "plain",
    `async function main(): Promise<void> {
  const dynamicValue: unknown = "from-value";
  console.log(await Promise.race([dynamicValue, Promise.resolve("other")]));
}
main();
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("from-value");
});

test("a raced value that holds a cycle keeps it and leaves nothing live at exit", async () => {
  /* The wrapper promise the race settles with carries the dyn trace callback
   * (it used to pass NULL where the intrinsic it replaced passed
   * scr_dyn_trace_v). A cycle THROUGH a dyn-boxed promise is documented as
   * never collected (SCR_DYN_PROMISE in scr_dyn.h), so this cannot tell the
   * two wrappers apart; it guards the payload path itself: the value keeps its
   * self reference and the sanitized lane's RC audit, which prints whatever
   * is still live at exit, reports nothing. */
  const result = await buildAndRun(
    "cycle",
    `async function main(): Promise<void> {
  const box = JSON.parse('{"name":"box"}') as Record<string, unknown>;
  box["self"] = box;
  const value: unknown = box;
  const winner = (await Promise.race([
    value,
    Promise.resolve("other"),
  ])) as Record<string, unknown>;
  console.log("winner", winner["name"], winner["self"] === value);
}
main();
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("winner box true");
  if (sanitize) expect(result.stderr).toBe("");
});
