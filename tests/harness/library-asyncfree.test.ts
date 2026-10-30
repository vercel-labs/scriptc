/* The async_free gate (stage 2 of the library emission mode): v1 library mode
 * refuses any async/timer/event-loop/ambient-process surface anywhere in
 * the module graph — SC4005's detector, module-graph-derived, never
 * runtime-observed. Programs here compile fine as EXECUTABLES (the exe
 * lane keeps its loop); what is asserted is the IR-level detection the
 * library path refuses on. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile, ir } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
/* Suite-flavor segment: the plain and SCRIPTC_SAN=1 suites may run
 * concurrently (the suite lock is per flavor) and both run these same
 * builds, so they must never share build dirs. */
const flavor = process.env["SCRIPTC_SAN"] === "1" ? "san" : "plain";

async function surfaceOf(name: string, source: string): Promise<string | null> {
  const outDir = join(cacheDir, `lib-asyncfree-${flavor}`, name);
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "main.ts");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    emitIr: true,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  }
  const mod = JSON.parse(readFileSync(result.irPath!, "utf8")) as ir.IrModule;
  const hit = ir.moduleLibAsyncSurface(mod);
  if (hit !== null) {
    // The anchor must be usable (a real file offset or the entry fallback).
    expect(hit.loc.file.length).toBeGreaterThan(0);
  }
  return hit === null ? null : hit.surface;
}

describe("async_free detection over the IR", () => {
  test("a sync graph is async_free", async () => {
    expect(
      await surfaceOf(
        "clean",
        `export function update(n: number): number { return n * 2; }\nconsole.log(update(21));\n`,
      ),
    ).toBeNull();
  });

  test("an async function anywhere refuses, named", async () => {
    expect(
      await surfaceOf(
        "async-fn",
        `async function tick(): Promise<number> { return 1; }\nvoid tick();\nconsole.log("x");\n`,
      ),
    ).toContain("async function ('tick')");
  });

  test("a generator refuses", async () => {
    expect(
      await surfaceOf(
        "gen",
        `function* seq(): Generator<number> { yield 1; }\nfor (const v of seq()) console.log(v);\n`,
      ),
    ).toContain("generator");
  });

  test("setTimeout refuses as the timers surface", async () => {
    expect(await surfaceOf("timer", `setTimeout(() => console.log("t"), 1);\n`)).toContain(
      "timers",
    );
  });

  test("the event-loop metrics refuse", async () => {
    expect(
      await surfaceOf(
        "eld",
        `import { monitorEventLoopDelay } from "node:perf_hooks";\nconst h = monitorEventLoopDelay();\nconsole.log(h.enable());\n`,
      ),
    ).toContain("monitorEventLoopDelay");
    expect(
      await surfaceOf(
        "elu",
        `import { performance } from "node:perf_hooks";\nconsole.log(performance.eventLoopUtilization().idle >= 0);\n`,
      ),
    ).toContain("eventLoopUtilization");
  });

  test("child_process refuses even in its synchronous spelling", async () => {
    expect(
      await surfaceOf(
        "child",
        `import { spawnSync } from "node:child_process";\nconst r = spawnSync("true", []);\nconsole.log(r.status === null ? -1 : r.status);\n`,
      ),
    ).toContain("child_process");
  });

  test("asymmetric keys and signatures refuse", async () => {
    expect(
      await surfaceOf(
        "pki",
        `import * as crypto from "node:crypto";\nconst { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });\nconsole.log(crypto.sign("sha256", Buffer.from("x"), privateKey).length > 0);\n`,
      ),
    ).toContain("asymmetric KeyObjects");
  });

  test("X509Certificate's key members refuse", async () => {
    expect(
      await surfaceOf(
        "x509-key",
        `import { X509Certificate } from "node:crypto";\nimport { readFileSync } from "node:fs";\nconst cert = new X509Certificate(readFileSync("cert.pem"));\nconsole.log(cert.verify(cert.publicKey));\n`,
      ),
    ).toContain("X509Certificate publicKey, verify and checkPrivateKey");
  });

  test("process signal listeners refuse", async () => {
    expect(
      await surfaceOf(
        "sig",
        `process.on("SIGINT", () => console.log("int"));\nconsole.log("armed");\n`,
      ),
    ).toContain("signal");
  });

  test("process output completion callbacks refuse as event-loop work", async () => {
    expect(
      await surfaceOf(
        "stdout-write-callback",
        `process.stdout.write("x", () => console.log("written"));\n`,
      ),
    ).toContain("process.stdout.write completion callbacks");
  });

  test("explicitly omitted process output callbacks remain async_free", async () => {
    expect(
      await surfaceOf(
        "stdout-write-undefined",
        `process.stdout.write("x", undefined);\nprocess.stdout.write("y", "utf8", undefined);\n`,
      ),
    ).toBeNull();
  });
});
