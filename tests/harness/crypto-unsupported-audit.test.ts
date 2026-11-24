/* The audited boundary of node:crypto's key types and WebCrypto's
 * algorithms. Node 24 implements each shape exercised here; this runtime
 * refuses them, and the refusal is what users can rely on: a coded SC2020
 * error naming the surface, raised where the call runs. The program is
 * JavaScript because the bundled declarations already exclude most of these
 * names from the typed surface; the audit pins the run-time behavior that
 * JavaScript reaches, and is the evidence the compatibility ledger cites for
 * the partial key-creation and SubtleCrypto rows.
 *
 * The setFips call is the compile-time fence: a deferred statement that
 * throws when it runs (SCRIPTC_DEFERRED_REPORT=0 keeps the one-time stderr
 * report out of this check). */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");

const PROGRAM = `import * as crypto from "node:crypto";
async function attempt(label, call) {
  try {
    const value = await call();
    console.log(label, "ok", value === undefined ? "undefined" : "value");
  } catch (error) {
    const reason = (error.message ?? "").replace(/ \\[SC2020 at .*\\]$/, "");
    console.log(label, error.code ?? error.name, "|", reason);
  }
}
await attempt("dsa keygen", () => crypto.generateKeyPairSync("dsa", { modulusLength: 1024 }));
await attempt("dh keygen", () => crypto.generateKeyPairSync("dh", { primeLength: 512 }));
await attempt("ed448 keygen", () => crypto.generateKeyPairSync("ed448"));
await attempt("setFips", () => crypto.setFips(false));
await attempt("subtle mlkem", () =>
  crypto.webcrypto.subtle.generateKey({ name: "ML-KEM-768" }, true, ["encapsulateBits"]),
);
await attempt("subtle ed448", () =>
  crypto.webcrypto.subtle.generateKey({ name: "Ed448" }, true, ["sign", "verify"]),
);
await attempt("subtle mldsa", () =>
  crypto.webcrypto.subtle.generateKey({ name: "ML-DSA-44" }, true, ["sign", "verify"]),
);
`;

const KEY_TYPE = "is part of the standard library types but has no scriptc lowering yet";

test("the audited crypto key-type and WebCrypto algorithm boundary is refused with SC2020", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-crypto-audit-"));
  try {
    const entry = join(dir, "main.mjs");
    const binary = join(dir, "main");
    writeFileSync(entry, PROGRAM);
    await execFileAsync(process.execPath, [cli, "build", entry, "-o", binary], {
      env: { ...process.env, SCRIPTC_NO_CACHE: "1" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    const run = await execFileAsync(binary, [], {
      encoding: "utf8",
      env: { ...process.env, SCRIPTC_DEFERRED_REPORT: "0" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20_000,
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      [
        `dsa keygen SC2020 | 'generateKeyPairSync for this key type' ${KEY_TYPE}`,
        `dh keygen SC2020 | 'generateKeyPairSync for this key type' ${KEY_TYPE}`,
        `ed448 keygen SC2020 | 'generateKeyPairSync for this key type' ${KEY_TYPE}`,
        `setFips SC2020 | 'crypto.setFips' ${KEY_TYPE}`,
        "subtle mlkem SC2020 | crypto.subtle.generateKey with the ML-KEM-768 algorithm is not supported yet",
        "subtle ed448 SC2020 | crypto.subtle.generateKey with the Ed448 algorithm is not supported yet",
        "subtle mldsa SC2020 | crypto.subtle.generateKey with the ML-DSA-44 algorithm is not supported yet",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
