/* The renegotiation's verification contract, native lane only (Node's
 * TLSSocket.renegotiate ignores its options, so there is no Node oracle for
 * these programs): a renegotiated handshake whose peer identity fails the
 * requested verification must not leak the rejected final flight's
 * plaintext into the socket, and a renegotiation keeps the SNI context's
 * client-certificate CA instead of falling back to the config's defaults.
 * The accepting case proves the option is honored rather than everything
 * being refused. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");

const refused = [
  "tests/fixtures/tls-renegotiate-verify/rejected-flight.ts",
  "tests/fixtures/tls-renegotiate-verify/context-ca.ts",
];
const accepted = ["tests/fixtures/tls-renegotiate-verify/accepted-identity.ts"];

async function run(program: string): Promise<string> {
  const file = join(repoRoot, program);
  const key = createHash("sha256")
    .update(file)
    .update(readFileSync(file))
    .update("plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `tls-renegotiate-verify-${key}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(file, {
    outPath: join(outDir, "program"),
    outDir,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const run = await execFileAsync(result.binaryPath, [], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
  });
  return run.stdout;
}

describe("tls renegotiation verification", () => {
  test.each(refused)(
    "%s refuses the identity and leaks nothing",
    { timeout: 300_000 },
    async (program) => {
      const stdout = await run(program);
      expect(stdout).toContain("leaked false");
      expect(stdout).not.toContain("leaked true");
    },
  );

  test.each(accepted)("%s accepts the verified identity", { timeout: 300_000 }, async (program) => {
    const stdout = await run(program);
    expect(stdout).toContain("settled ok");
    expect(stdout).toContain("leaked true");
  });
});
