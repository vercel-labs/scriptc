// TLS trust stores that depend on the process's NODE_EXTRA_CA_CERTS: a
// server's ca option, where an empty Buffer is an empty store and an empty
// string is the default one. The corpus cannot set the environment, so the
// fixture runs here under Node and as a binary with the test CA added.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("a server's empty ca Buffer is an empty trust store, as in Node", async () => {
  const entry = join(repoRoot, "tests/fixtures/tls/empty-ca.ts");
  const outDir = join(cacheDir, `tls-trust-store-${sanitize ? "san" : "plain"}`);
  mkdirSync(outDir, { recursive: true });
  const result = await compile(entry, {
    outPath: join(outDir, "empty-ca"),
    outDir,
    sanitize,
    backend: "llvm",
  });
  expect(result.ok, !result.ok ? JSON.stringify(result.diagnostics, null, 2) : "").toBe(true);
  if (!result.ok) return;
  const env = {
    ...process.env,
    NODE_EXTRA_CA_CERTS: join(repoRoot, "tests/fixtures/server/certs/ca.pem"),
  };
  const [native, node] = await Promise.all([
    execFileAsync(result.binaryPath, [], { cwd: repoRoot, env }),
    execFileAsync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], {
      cwd: repoRoot,
      env,
    }),
  ]);
  expect(native.stdout).toBe(node.stdout);
  expect(node.stdout).toContain("empty Buffer false SELF_SIGNED_CERT_IN_CHAIN");
}, 120_000);
