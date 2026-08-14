/* node:midi harness — two lanes, both gated on host capability.
 *
 * 1. The WASI refusal. wasm32-wasi is a production LLVM target, but WASI
 *    Preview 1 has no MIDI API, so any midi surface must fence at compile
 *    time with SC3002 (the socket/child-process precedent in index.ts).
 *    Reaching the wasi build platform needs zigcc on PATH, exactly like the
 *    wasm32-wasi differential lane, so this describe skips without zig.
 *
 * 2. The virtual-port loopback differential. The corpus is differential
 *    against Node, but a MIDI program that touches ports cannot be made
 *    byte-identical without a real MIDI stack: this CI container has no ALSA
 *    (the runtime compiles a stub that enumerates 0 ports and throws on
 *    open), and Node needs @julusian/midi (a native RtMidi addon) to answer
 *    at all. So this case is CAPABILITY-GATED: it runs only on a host where
 *    the Node baseline can actually open a virtual port pair (POSIX ALSA
 *    sequencer / CoreMIDI), and is skipped otherwise. It documents intent
 *    and validates real hardware-free loopback on a capable host; it must
 *    never break CI. See tests/fixtures/midi/cases/virtual-loopback/main.ts. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const require = createRequire(import.meta.url);

function zigOnPath(): boolean {
  try {
    execFileSync("zig", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!zigOnPath())("midi WASI refusal", () => {
  let oldCc: string | undefined;
  let oldTarget: string | undefined;

  beforeAll(() => {
    oldCc = process.env["SCRIPTC_CC"];
    oldTarget = process.env["SCRIPTC_TARGET"];
    process.env["SCRIPTC_CC"] = "zigcc";
    process.env["SCRIPTC_TARGET"] = "wasm32-wasi";
  });

  afterAll(() => {
    if (oldCc === undefined) delete process.env["SCRIPTC_CC"];
    else process.env["SCRIPTC_CC"] = oldCc;
    if (oldTarget === undefined) delete process.env["SCRIPTC_TARGET"];
    else process.env["SCRIPTC_TARGET"] = oldTarget;
  });

  test("a midi surface fences before linking with SC3002", async () => {
    const entry = join(repoRoot, "tests/coverage-fixtures/midi-enumerate.ts");
    const outDir = join(cacheDir, "midi-wasi");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, { outDir, outPath: join(outDir, "program.wasm") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]?.code).toBe("SC3002");
      expect(result.diagnostics[0]?.message).toMatch(/MIDI/);
    }
  });
});

/** Whether this host can run the virtual-port loopback: the "midi" dev-dep
 * (aliased to @julusian/midi) must resolve AND actually open a virtual
 * output/input pair — which needs a POSIX MIDI backend with virtual ports.
 * Windows WinMM has no user-space virtual ports, so it is excluded. When the
 * Node baseline can do this, the native ALSA/CoreMIDI backend on the same
 * host has virtual ports too. Any failure (missing addon, no ALSA) → skip. */
function midiLoopbackAvailable(): boolean {
  if (process.platform === "win32") return false;
  try {
    require.resolve("midi");
  } catch {
    return false;
  }
  const probe = [
    'const midi = require("midi");',
    'const out = new midi.Output();',
    'out.openVirtualPort("scriptc-probe");',
    'const inp = new midi.Input();',
    'let seen = false;',
    'for (let i = 0; i < inp.getPortCount(); i++) {',
    '  if (inp.getPortName(i).includes("scriptc-probe")) seen = true;',
    '}',
    'inp.closePort();',
    'out.closePort();',
    'process.exit(seen ? 0 : 1);',
  ].join("");
  const res = spawnSync(process.execPath, ["-e", probe], { stdio: "ignore", timeout: 15_000 });
  return res.status === 0;
}

async function buildLoopback(entry: string): Promise<string> {
  const key = createHash("sha256").update(readFileSync(entry)).digest("hex").slice(0, 16);
  const outDir = join(cacheDir, `midi-loopback-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, { outPath: join(outDir, "program"), outDir, backend: "c" });
  if (!result.ok) {
    throw new Error(
      "midi loopback fixture failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  return result.binaryPath;
}

function runLane(cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`midi loopback timed out\nstderr:\n${errText}`));
    }, 30_000);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (errText += c.toString("utf8")));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`midi loopback died to ${signal}\nstderr:\n${errText}`));
      else resolve({ stdout: Buffer.concat(out).toString("utf8"), exitCode: code ?? 0 });
    });
  });
}

describe.skipIf(!midiLoopbackAvailable())("midi virtual-port loopback differential", () => {
  const entry = join(repoRoot, "tests/fixtures/midi/cases/virtual-loopback/main.ts");

  test("native loopback matches Node byte-for-byte", async () => {
    const binary = await buildLoopback(entry);
    // Sequential, not parallel: both lanes open a virtual MIDI port named the
    // same, so keep the host's port table uncontended between the two runs.
    const nodeRes = await runLane("node", [entry]);
    const nativeRes = await runLane(binary, []);
    expect(nativeRes.stdout).toBe(nodeRes.stdout);
    expect(nativeRes.exitCode).toBe(nodeRes.exitCode);
  }, 120_000);
});
