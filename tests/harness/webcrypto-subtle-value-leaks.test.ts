/* A refused detached SubtleCrypto method call keeps nothing behind. The
 * method value's fence takes its captured name with a +1 reference; throwing
 * the refusal without releasing it left one string per call, so a program
 * that catches the refusal and carries on failed the RC audit at exit (the
 * sanitized differential lanes do not call a detached method: Node's
 * detached call rejects its returned promise instead of throwing, so no
 * corpus can compare the two). Linux only (Apple's ASan has no
 * LeakSanitizer); runs in the SCRIPTC_SAN=1 lane. */
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
  "refused detached SubtleCrypto methods under LeakSanitizer",
  () => {
    test("a caught refusal reports no leaks", { timeout: 300_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-subtle-fence-leaks-"));
      try {
        const entry = join(dir, "main.mjs");
        writeFileSync(
          entry,
          "const { subtle } = globalThis.crypto;\n" +
            "const importKey = subtle.importKey;\n" +
            "const encrypt = subtle.encrypt;\n" +
            "let refused = 0;\n" +
            "for (let i = 0; i < 50; i++) {\n" +
            "  try {\n" +
            '    importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]);\n' +
            "  } catch {\n" +
            "    refused++;\n" +
            "  }\n" +
            "  try {\n" +
            '    encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, importKey, new Uint8Array(1));\n' +
            "  } catch {\n" +
            "    refused++;\n" +
            "  }\n" +
            "}\n" +
            'console.log("refused", refused, typeof importKey);\n',
        );
        const outDir = join(cacheDir, "webcrypto-subtle-value-leaks");
        mkdirSync(outDir, { recursive: true });
        const outPath = join(outDir, "program");
        const result = await compile(entry, { outPath, outDir, sanitize: true, backend: "llvm" });
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
        expect(run.stdout).toBe("refused 100 function\n");
        expect(run.stderr).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
