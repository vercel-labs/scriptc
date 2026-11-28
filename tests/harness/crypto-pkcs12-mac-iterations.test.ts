/* A PKCS#12 bundle's MAC iteration count is file-controlled, and the MAC key
 * derivation runs before the parse can tell the bundle is forged. The runtime
 * performs at most SP_P12_MAX_ITERATIONS (1,000,000) of them and refuses a
 * larger count with ERR_CRYPTO_OPERATION_FAILED instead of stalling the event
 * loop; OpenSSL, which Node uses, has no such bound. Only the native program
 * runs: this pins the policy, not Node parity. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

// A PFX whose MacData names 1,000,001 iterations and an arbitrary digest:
// its content can never verify, but the count is what the parse sees first.
const BUNDLE =
  "MG0CAQMwJAYJKoZIhvcNAQcBoBcEFTATMBEGCSqGSIb3DQEHAaAEBAIwADBCMDEwDQYJYIZIAWUDBAIBBQAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgAESIzRFVmdwIDD0JB";

const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("a PKCS#12 MAC iteration count beyond the limit is refused", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-pkcs12-iterations-"));
  try {
    const entry = join(outDir, "main.mjs");
    writeFileSync(
      entry,
      `import { parsePKCS12 } from "node:crypto";
try {
  parsePKCS12(Buffer.from(${JSON.stringify(BUNDLE)}, "base64"));
  console.log("parsed");
} catch (error) {
  console.log(error.code);
}
`,
    );
    const result = await compile(entry, {
      backend: "llvm",
      sanitize,
      outDir,
      outPath: join(outDir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;

    const ran = spawnSync(result.binaryPath, [], { encoding: "utf8", timeout: 20000 });
    expect(ran.error).toBeUndefined();
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("ERR_CRYPTO_OPERATION_FAILED\n");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
