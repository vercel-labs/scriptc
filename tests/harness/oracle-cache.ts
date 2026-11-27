/** The Node-oracle result cache shared by the corpus suites.
 *
 * Node's verdict for a corpus program is a pure function of the program bytes,
 * the shims, and the Node build (corpus stdout is deterministic by
 * construction — it must be identical to a non-Node native binary's output). So
 * cache it, keyed by all of those plus the invocation shape (the inherited
 * environment, see oracle-env.ts, and the cwd). Only the SPAWN is skipped: the
 * native side always runs live and the comparison itself never changes.
 * SCRIPTC_NO_CACHE=1 (or an unset SCRIPTC_CACHE_DIR) disables the cache in both
 * directions — no reads, no writes. Storage shares the compile cache's root and
 * its LRU sweep (see native-toolchain.ts).
 *
 * The two differential suites split the corpus identically, so they share this
 * cache: whichever suite records a program's Node verdict first, the other
 * reuses it. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ts5 from "typescript5";
import { oracleEnvKey } from "./oracle-env.js";
import { legacyDecoratorTypescriptVersion } from "./tsc-legacy-decorators.js";

const execFileAsync = promisify(execFile);

export interface OracleRunResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export interface NodeOracleCacheOptions {
  /** The repository root; cache keys hash paths relative to it. */
  repoRoot: string;
  /** The comptime shim the Node oracle loads; its bytes are part of the key. */
  comptimeShim: string;
  /** Every byte a program run depends on: the entry plus its siblings. */
  programInputs: (file: string) => string[];
  /** The Node the suite spawns for the oracle. The key records what THAT
   * executable reports as `process.execPath` and `process.version`, not what
   * `node` on PATH would: the two suites spawn different commands (`node`
   * vs `process.execPath`), and when PATH's Node differs from Vitest's they
   * must not share verdicts. Defaults to `node`. */
  nodeCommand?: string;
}

/** Real-time programs are EXCLUDED from the oracle cache: a timer-interleave
 * program's stdout is only deterministic in the sense that Node and the
 * native binary agree when they run under the SAME instantaneous load
 * (the harness runs them concurrently). Caching Node's verdict from one run
 * and comparing it against a live native run later decouples the two sides —
 * a load-skewed interleave recorded once would keep failing until evicted
 * (observed with 1430-promise-race.ts). Those programs — 18 of 298 — always
 * spawn Node live. VOLATILE-HOST programs ride the same exclusion:
 * os.networkInterfaces output changes under the harness's feet (macOS
 * rotates the awdl0/llw0 link-local address), so a cached Node verdict
 * goes stale against a live native read (observed with 1480). The platform
 * certificate store is mutable host state too: a cached system-CA predicate
 * must not outlive an administrator or keychain change. */
export function usesVolatileHostState(inputs: string[]): boolean {
  return inputs.some((f) =>
    /set(Timeout|Interval)|Promise\.(race|any)|networkInterfaces|getCACertificates\s*\(\s*["']system["']/.test(
      readFileSync(f, "utf8"),
    ),
  );
}

/** Opens the cache and returns `spawnCached(file, spawn)`: it answers the
 * recorded verdict when there is one, and otherwise awaits `spawn()` (the
 * suite's own live Node invocation) and records the result. */
export function createNodeOracleCache(options: NodeOracleCacheOptions) {
  const { repoRoot, comptimeShim, programInputs, nodeCommand = "node" } = options;
  const oracleDir =
    process.env["SCRIPTC_NO_CACHE"] !== "1" && process.env["SCRIPTC_CACHE_DIR"]
      ? join(process.env["SCRIPTC_CACHE_DIR"], "oracle")
      : null;
  if (oracleDir !== null) mkdirSync(oracleDir, { recursive: true });

  let oracleKeyBaseMemo: Promise<string> | null = null;
  function oracleKeyBase(): Promise<string> {
    // Ask the EXECUTABLE THE SUITE SPAWNS for its path and version rather than
    // trusting process.version (Vitest's own node could differ) or PATH's
    // `node` (the LLVM suite spawns process.execPath). Two different Node
    // builds then key different cache entries and never share a verdict.
    oracleKeyBaseMemo ??= execFileAsync(nodeCommand, [
      "-p",
      "JSON.stringify([process.execPath, process.version])",
    ]).then(({ stdout }) =>
      createHash("sha256")
        .update("oracle-v2\0")
        .update(stdout)
        .update("\0")
        // Decorator programs run tsc's downlevel on the Node side — its
        // emitter version is part of the verdict, for the standard oracle's
        // TypeScript 5 and the legacy oracle's TypeScript 7 alike.
        .update(ts5.version)
        .update("\0")
        .update(legacyDecoratorTypescriptVersion)
        .update("\0")
        .update(readFileSync(fileURLToPath(comptimeShim)))
        .update("\0")
        .update("\0")
        .update(oracleEnvKey(process.env))
        .update("\0")
        .update(process.cwd())
        .update("\0")
        .digest("hex"),
    );
    return oracleKeyBaseMemo;
  }

  return async function spawnCached<T extends OracleRunResult>(
    file: string,
    spawn: () => Promise<T>,
  ): Promise<T> {
    let cachePath: string | null = null;
    const inputs = programInputs(file);
    if (oracleDir !== null && !usesVolatileHostState(inputs)) {
      // A directory can hold several entries over the same inputs.
      const h = createHash("sha256")
        .update(await oracleKeyBase())
        .update(file.slice(repoRoot.length))
        .update("\0");
      for (const f of inputs) {
        h.update(f.slice(repoRoot.length)).update("\0").update(readFileSync(f)).update("\0");
      }
      cachePath = join(oracleDir, `${h.digest("hex")}.json`);
      try {
        // v2 carries stderr (the harness compares it for exit-0 programs);
        // v1 records read as misses and rewrite themselves.
        const rec = JSON.parse(readFileSync(cachePath, "utf8")) as {
          v?: number;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
        };
        if (
          rec.v === 2 &&
          typeof rec.exitCode === "number" &&
          typeof rec.stdout === "string" &&
          typeof rec.stderr === "string"
        ) {
          const now = new Date();
          utimesSync(cachePath, now, now); // LRU bump for the shared sweep
          return {
            stdout: Buffer.from(rec.stdout, "base64"),
            stderr: Buffer.from(rec.stderr, "base64"),
            exitCode: rec.exitCode,
          } as T;
        }
      } catch {
        /* miss (or unreadable record) — spawn Node below */
      }
    }
    const res = await spawn();
    if (cachePath !== null) {
      try {
        const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}`;
        writeFileSync(
          tmp,
          JSON.stringify({
            v: 2,
            exitCode: res.exitCode,
            stdout: res.stdout.toString("base64"),
            stderr: res.stderr.toString("base64"),
          }),
        );
        renameSync(tmp, cachePath); // atomic publish; concurrent winners are equivalent
      } catch {
        /* caching is best-effort */
      }
    }
    return res;
  };
}
