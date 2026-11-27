/* A FinalizationRegistry that outlives its tokens still answers unregister
 * for them without keeping them alive: a long-lived registry registering
 * large Blob tokens must not accumulate their payloads. The number is the
 * process's own peak RSS, so this cannot be a differential corpus program. */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

const PROGRAM = `const registry = new FinalizationRegistry(() => {});
const live = new Blob([new Uint8Array(1024)]);
registry.register({ live: true }, "live", live);
for (let i = 0; i < 96; i++) {
  const token = new Blob([new Uint8Array(4 * 1024 * 1024)]);
  registry.register({ i }, i, token);
}
console.log("unregister", registry.unregister(live), registry.unregister(live));
console.log("maxrss", Math.round(process.resourceUsage().maxRSS));
`;

async function run(source: string): Promise<{ stdout: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-registry-tokens-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", code: -1 };
  try {
    const { stdout } = await execFileAsync(result.binaryPath, [], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; code?: number };
    return { stdout: failed.stdout ?? "", code: failed.code ?? -1 };
  }
}

test("a registry that outlives its Blob tokens keeps no payload", async () => {
  const { stdout, code } = await run(PROGRAM);
  expect(code).toBe(0);
  expect(stdout).toContain("unregister true false");
  const match = /maxrss (\d+)/.exec(stdout);
  expect(match).not.toBeNull();
  /* 96 discarded tokens carry 384 MiB of payloads; a registry that kept
   * them would put the peak near 480 MiB. The runtime's own footprint is
   * about 100 MiB, so 200 MiB leaves room for the transient copies only. */
  if (process.env["SCRIPTC_SAN"] !== "1") expect(Number(match![1])).toBeLessThan(200 * 1024);
}, 300_000);
