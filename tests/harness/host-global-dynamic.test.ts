/* The dynamic global object's answer for the Node globals the native runtime
 * does not implement (WebSocket, FormData, the Performance family, …). Node
 * HAS these values, so the native answer must not be a silent undefined: the
 * compiler derives the set from the Node ledger (host-globals.ts), hands it to
 * scr_global_host_absent.c, and a computed read of the global object or
 * `… in globalThis` throws Node's TypeError instead.
 *
 * These forms cannot be corpus programs: corpus output matches Node byte for
 * byte, and Node returns the value here (that is the point of the refusal).
 * The absent-capability probes that must keep answering undefined cover the
 * other direction (8831-host-global-dynamic-probes.ts). */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const outDir = join(import.meta.dirname, "../../node_modules/.cache/scriptc-tests/host-globals");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runProgram(name: string, source: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-host-global-${name}-`));
  try {
    mkdirSync(outDir, { recursive: true });
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source);
    const outPath = join(outDir, name);
    const result = await compile(entry, { outPath, outDir, sanitize });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const pending = execFileAsync(outPath, [], { encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout, stderr } = await pending;
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const missing = (name: string) => `'${name}' is a Node global that native code does not provide`;

test("a computed read of the global object throws for a host global", async () => {
  const result = await runProgram(
    "computed-read",
    `const scope = globalThis as Record<string, unknown>;
const key: string = "WebSocket";
console.log(scope[key]);
`,
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`TypeError: ${missing("WebSocket")}`);
});

test("a computed read of globalThis throws for a host global", async () => {
  const result = await runProgram(
    "computed-global",
    `const key: string = "FormData";
console.log(typeof (globalThis as any)[key]);
`,
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`TypeError: ${missing("FormData")}`);
});

test("'X' in globalThis throws for a host global", async () => {
  const result = await runProgram(
    "in-literal",
    `console.log("URLPattern" in globalThis);
`,
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`TypeError: ${missing("URLPattern")}`);
});

test("a computed 'X' in globalThis throws for a host global", async () => {
  const result = await runProgram(
    "in-computed",
    `const key: string = "ReadableStreamBYOBReader";
console.log(key in globalThis);
`,
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`TypeError: ${missing("ReadableStreamBYOBReader")}`);
});

test("absent capabilities and implemented globals keep their answers", async () => {
  const result = await runProgram(
    "absent",
    `const scope = globalThis as Record<string, unknown>;
const names = ["Bun", "Deno", "Temporal"];
for (const name of names) console.log(name, typeof scope[name], name in globalThis);
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    ["Bun undefined false", "Deno undefined false", "Temporal undefined false", ""].join("\n"),
  );
});

test("a static host-global spelling through the cast alias is the global read", async () => {
  // The alias is the global object, so `s.WebSocket` is the same read as
  // `globalThis.WebSocket`: the constructor value native code does not
  // provide (host-global-values.ts), never a dynamic undefined. The computed
  // spelling over the same alias throws instead (the tests above).
  const result = await runProgram(
    "static-alias",
    `const s = globalThis as Record<string, unknown>;
console.log(typeof s.WebSocket, (s.WebSocket as any).name);
console.log(typeof s["FormData"], (s["FormData"] as any).name);
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(["function WebSocket", "function FormData", ""].join("\n"));
});
