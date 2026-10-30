/* Exit with Node loaded (scope-B NI-7c): island code loads node:tls (Node
 * then loads the root certificates on threads of its own) or leaves OpenSSL
 * work on libuv's thread pool, and the program exits at once. The bridge's
 * stop runs Node's own exit sequence (join the pool, dispose the platform,
 * join the certificate threads) before the process's exit handlers run
 * OpenSSL's cleanup; without it a certificate thread inside OpenSSL crashed
 * the exit (SIGSEGV/SIGABRT in up to half the runs).
 * Many runs per mode; SCRIPTC_NODE_ISLAND_EXIT_RUNS scales them. Needs a
 * libnode pack in SCRIPTC_LIBNODE. */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "tests/fixtures/node-island/exit-tls.mjs");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-exit");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const pack = libnodePack();
const runs = Number(process.env["SCRIPTC_NODE_ISLAND_EXIT_RUNS"] ?? (sanitize ? "10" : "40"));

let binary = "";
// Node loads the system and extra root certificates on their own threads
// when node:tls loads, with these set: the threads the exit must wait for.
const caFile = ["/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/cert.pem"].find((f) =>
  existsSync(f),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_USE_SYSTEM_CA: "1",
  ...(caFile === undefined ? {} : { NODE_EXTRA_CA_CERTS: caFile }),
};

async function runOnce(mode: string): Promise<{ code: number | string; stdout: string }> {
  try {
    const { stdout } = await execFileAsync(binary, [mode], { encoding: "utf8", env });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; signal?: string; stdout?: string };
    return { code: e.signal ?? e.code ?? "?", stdout: e.stdout ?? "" };
  }
}

describe.skipIf(pack === null)("Node islands: exit with OpenSSL work in flight", () => {
  beforeAll(async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(fixture, {
      outPath: join(outDir, "exit-tls"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    binary = result.binaryPath;
  }, 300_000);

  test.each([
    "early",
    "load",
    "exit",
    "keys",
    "return",
    "early-return",
    "load-return",
    "keys-return",
  ])(
    "%s: every run exits 0",
    async (mode) => {
      const outcomes: (number | string)[] = [];
      for (let i = 0; i < runs; i += 4) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(4, runs - i) }, () => runOnce(mode)),
        );
        for (const r of batch) {
          outcomes.push(r.code);
          expect(r.stdout).toBe(`roots true\n`);
        }
      }
      expect(outcomes.filter((c) => c !== 0)).toEqual([]);
    },
    600_000,
  );
});
