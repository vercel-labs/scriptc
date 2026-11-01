// The blocked-SPKI policy Node 24.22.1 applies at certificate verification
// (src/crypto/crypto_context.cc, kBlockedSPKIs): a chain that contains a
// blocked public key fails as CERT_REVOKED ("certificate revoked"), a chain
// without one verifies unchanged. Node's list holds real CA keys, so the
// fixture injects one of its own public keys instead: the Node run through
// Node's test hook, the native run through the runtime's.
//
// expected/<case>.txt is what Node 24.22.1 prints for the fixture with that
// key blocked (tests/fixtures/tls-spki/record.mjs). The compiled binary must
// print it byte for byte. When the Node running this suite carries the same
// hook (24.22.1 and newer), the suite re-runs Node live and compares, so a
// pin bump re-checks the recordings instead of trusting them.
import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const fixtureDir = join(repoRoot, "tests/fixtures/tls-spki");
const entry = join(fixtureDir, "main.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

// case -> the fixture certificate whose public key that run blocks
const cases: [string, string][] = [
  ["clean", ""],
  ["blocked-intermediate", "inter"],
  ["blocked-root", "root"],
  ["blocked-unrelated", "unrelated"],
  ["blocked-client", "client"],
];

function digest(name: string): string {
  if (name === "") return "";
  const der = new X509Certificate(readFileSync(join(fixtureDir, `${name}.pem`))).publicKey.export({
    type: "spki",
    format: "der",
  });
  return createHash("sha256").update(der).digest("hex");
}

test("a blocked public key fails the chain as CERT_REVOKED, exactly as Node reports it", async () => {
  const outDir = join(cacheDir, `tls-spki-${sanitize ? "san" : "plain"}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "tls-spki"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;

  for (const [name, blocked] of cases) {
    const env = { ...process.env, SCRIPTC_TLS_BLOCKED_SPKI: digest(blocked) };
    const expected = readFileSync(join(fixtureDir, "expected", `${name}.txt`), "utf8");
    const native = await execFileAsync(result.binaryPath, [], { cwd: repoRoot, env });
    expect(native.stdout, name).toBe(expected);

    // the recording re-checked on the running Node, when it has the hook
    let node;
    try {
      node = await execFileAsync(
        process.execPath,
        [
          "--expose-internals",
          "--no-warnings",
          "--require",
          join(fixtureDir, "node-hook.cjs"),
          entry,
        ],
        { cwd: repoRoot, env },
      );
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "");
      if (stderr.includes("addBlockedSPKIForTesting")) continue; // an older Node: the recording stands alone
      throw error;
    }
    expect(node.stdout, `${name} (Node ${process.version})`).toBe(expected);
  }
}, 180_000);
