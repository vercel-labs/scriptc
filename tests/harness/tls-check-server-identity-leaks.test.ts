/* A malformed subjectAltName string keeps nothing behind. The standalone
 * tls.checkServerIdentity materializes a typed certificate's subject, CN and
 * altnames when it reads them; the ERR_TLS_CERT_ALTNAME_FORMAT answer for a
 * malformed quoted SAN returned without releasing them, so a service that
 * catches the validation failure (routine for untrusted certificates) leaked
 * the subject payloads on every attempt — the RC audit reported them as dyn
 * values live at exit. Linux only (Apple's ASan has no LeakSanitizer); runs
 * in the SCRIPTC_SAN=1 lane. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const cacheDir = join(import.meta.dirname, "../../node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

describe.skipIf(!sanitize || process.platform !== "linux")(
  "tls.checkServerIdentity in the LeakSanitizer lane",
  () => {
    test("a caught malformed-SAN failure reports no leaks", { timeout: 300_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-tls-ident-leaks-"));
      try {
        const entry = join(dir, "main.ts");
        writeFileSync(
          entry,
          'import * as tls from "node:tls";\n' +
            "\n" +
            "interface Cert {\n" +
            "  subject: { CN: string };\n" +
            "  subjectaltname: string;\n" +
            "}\n" +
            'const cert: Cert = { subject: { CN: "example.com" }, subjectaltname: \'DNS:"broken\' };\n' +
            "let refused = 0;\n" +
            "for (let i = 0; i < 50; i++) {\n" +
            "  try {\n" +
            '    tls.checkServerIdentity("example.com", cert as unknown as tls.PeerCertificate);\n' +
            "  } catch {\n" +
            "    refused++;\n" +
            "  }\n" +
            "}\n" +
            'console.log("refused", refused);\n',
        );
        const outDir = join(cacheDir, "tls-check-server-identity-leaks");
        mkdirSync(outDir, { recursive: true });
        const result = await compile(entry, {
          outPath: join(outDir, "program"),
          outDir,
          sanitize: true,
          backend: "llvm",
        });
        if (!result.ok) {
          throw new Error(
            "program failed to compile:\n" +
              result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
          );
        }
        const run = await execFileAsync(result.binaryPath, [], {
          env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1" },
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(run.stdout).toBe("refused 50\n");
        expect(run.stderr).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
