/* The runtime options record of https.createServer honors the supported TLS
 * members inherited from its prototype (requestCert and ca reach the
 * handshake), so an unsupported documented member inherited the same way
 * must not be ignored: an inherited `crl` has to refuse the construction
 * rather than serve a context that checks no revocation list. The corpus
 * differential cannot express the refusal (Node accepts the record), so the
 * check runs the compiled program and reads its answer. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const exec = promisify(execFile);

const PROGRAM = `
import { readFileSync } from "node:fs";
import * as https from "node:https";

const cert = readFileSync("tests/fixtures/server/certs/localhost.pem");
const key = readFileSync("tests/fixtures/server/certs/localhost-key.pem");

const base = { crl: "-----BEGIN X509 CRL-----" };
const options = Object.create(base);
options.cert = cert;
options.key = key;
try {
  https.createServer(options, () => {});
  console.log("constructed");
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.log("refused", e.code);
}
`;

test(
  "an inherited unsupported TLS option refuses the record instead of being ignored",
  { timeout: 300_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-https-fence-"));
    try {
      const source = join(dir, "inherited-crl.ts");
      await writeFile(source, PROGRAM);
      const result = await compile(source, {
        backend: "llvm",
        outDir: dir,
        outPath: join(dir, "inherited-crl"),
      });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      if (!result.ok) return;
      const { stdout } = await exec(result.binaryPath, [], {
        cwd: join(import.meta.dirname, "../.."),
        timeout: 120_000,
      });
      expect(stdout).toBe("refused SC2020\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
