/* The LISTENING-process differential: net/http server fixtures run under
 * Node AND compiled, and a shared per-case CLIENT DRIVER (a Node script,
 * identical for both lanes) talks to whichever lane is up. Nothing about
 * a listening program can be compared from stdout alone — the driver IS
 * the workload — so the contract has three legs, each byte-exact between
 * lanes: the SERVER program's stdout, the SERVER's exit code, and the
 * DRIVER's stdout.
 *
 * The port protocol: a fixture that listens binds port 0 and reports the
 * real port on STDERR as `PORT <n>` (stderr is never compared, so
 * ephemeral ports stay out of every compared stream); the harness waits
 * for that line, runs `node driver.mjs <port>`, and the fixture is
 * expected to shut itself down when the driver's conversation ends
 * (close the server, let the loop drain). Driver-less fixtures (pure
 * client programs: connect-refused shapes) skip the protocol and run
 * like corpus programs; refused-connection fixtures probe their own
 * ephemeral port (bind 0, close, connect) since a static build has no
 * string→number conversion for an argv port.
 *
 * SCRIPTC_SAN=1 rebuilds with ASan + the RC audit: socket/server handle
 * hygiene runs over every case. This file is the template the TLS and
 * http2 lanes inherit (the design note atop scr_net.c has the story). */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { shardSelect, shardSuffix } from "./shard.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixturesRoot = join(repoRoot, "tests/fixtures/server");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface ProgramRun {
  stdout: Buffer;
  exitCode: number;
  /** The driver's stdout, "" for driver-less cases. */
  driverStdout: string;
}

/** Runs one lane: spawn the server program, follow the PORT protocol when
 * the case has a driver, and collect all three compared legs. */
function runLane(cmd: string, args: string[], driver: string | null): Promise<ProgramRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let errText = "";
    let driverStdout = "";
    let driverStarted = false;
    let driverDone: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server program timed out\nstderr so far:\n${errText}`));
    }, 60_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      errText += c.toString("utf8");
      if (driver !== null && !driverStarted) {
        const m = /^PORT (\d+)$/m.exec(errText);
        if (m) {
          driverStarted = true;
          driverDone = new Promise<void>((res, rej) => {
            const d = spawn("node", [driver, m[1]!], { stdio: ["ignore", "pipe", "inherit"] });
            d.stdout.on("data", (c: Buffer) => (driverStdout += c.toString("utf8")));
            d.on("close", (code) => {
              if (code === 0) res();
              else rej(new Error(`driver exited ${code}`));
            });
          });
        }
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) {
        reject(new Error(`server program died to ${signal}\nstderr:\n${errText}`));
        return;
      }
      if (driver !== null && !driverStarted) {
        reject(new Error(`server program exited without a PORT line\nstderr:\n${errText}`));
        return;
      }
      driverDone.then(
        () => resolve({ stdout: Buffer.concat(out), exitCode: code ?? 0, driverStdout }),
        reject,
      );
    });
  });
}

async function build(entry: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(entry).update(readFileSync(entry));
  const key = hash.update(sanitize ? "san" : "plain").digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `server-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "program"),
    outDir,
    sanitize,
    // Pinned: the listening-process differential was written against the
    // C lane; keeping lane identity fixed keeps a three-leg diff meaning
    // "server behavior changed", never "the default backend moved".
    backend: "c",
  });
  if (!result.ok) {
    throw new Error(
      "server fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

// main.ts cases are the TS lane; main.js cases pin the JS-entry lane's
// server surface (the ambient receiver, the dyn-binding handle) — both
// lanes run the identical three-leg comparison. SCRIPTC_TEST_SHARD (CI's
// matrix) keeps only this shard's slice, keyed by case name.
const cases = shardSelect(
  [...globSync(join(fixturesRoot, "cases/*/main.ts")), ...globSync(join(fixturesRoot, "cases/*/main.js"))]
    .sort()
    .map((entry) => ({
      name: entry.split("/").at(-2)!,
      entry,
      driver: existsSync(join(entry, "../driver.mjs")) ? join(entry, "../driver.mjs") : null,
    })),
  (c) => c.name,
);

describe(`server differential (${cases.length} programs${sanitize ? ", sanitized" : ""}${shardSuffix()})`, () => {
  test.for(cases.map((c) => [c.name, c] as const))("%s", async ([, c]) => {
    const binary = await build(c.entry);
    // Sequential, not parallel: both lanes bind ephemeral ports and drive
    // real sockets — parallelism buys little and interleaves kernel state.
    const nodeRes = await runLane("node", [c.entry], c.driver);
    const nativeRes = await runLane(binary, [], c.driver);
    expect(nativeRes.stdout.toString("utf8")).toBe(nodeRes.stdout.toString("utf8"));
    if (!nodeRes.stdout.equals(nativeRes.stdout)) {
      expect.unreachable("stdout differed at byte level but not after utf8 decode");
    }
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
    expect(nativeRes.driverStdout).toBe(nodeRes.driverStdout);
  }, 120_000);

  test("net-reuse-port emits the additive LLVM ABI", async () => {
    const entry = join(fixturesRoot, "cases/net-reuse-port/main.ts");
    const outDir = join(cacheDir, `server-llvm-reuse-port${sanitize ? "-san" : ""}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, {
      outPath: join(outDir, "program"),
      outDir,
      sanitize,
      backend: "llvm",
    });
    if (!result.ok) {
      throw new Error(
        "net-reuse-port LLVM fixture failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    }
    const llvm = readFileSync(result.cPath, "utf8");
    expect(llvm).toContain(
      "declare void @scr_net_listen_opts_reuse_port(ptr, double, ptr, i1 zeroext, i1 zeroext, ptr)",
    );
    expect(llvm).toMatch(
      /call void @scr_net_listen_opts_reuse_port\(ptr [^,]+, double [^,]+, ptr [^,]+, i1 [^,]+, i1 [^,]+, ptr [^)]+\)/,
    );
  });
});
