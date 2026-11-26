/* A rejected detached SubtleCrypto method call and a called method value keep
 * nothing behind. The method value's fence takes its captured name with a +1
 * reference (throwing it without releasing left one string per refused call),
 * and the digest value's update answers the hash it retained for chaining (the
 * digest owns that reference and must let go of it, or one hash context leaks
 * per call). Both made a program that catches a refusal or digests in a loop
 * fail the RC audit at exit; neither can be a corpus, because Node's detached
 * call rejects its returned promise instead of throwing. Linux only (Apple's
 * ASan has no LeakSanitizer); runs in the SCRIPTC_SAN=1 lane. */
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

/** Compile `source` sanitized, run it with LeakSanitizer on, and answer what
 * it printed. */
async function runUnderLeakSanitizer(name: string, source: string) {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-${name}-leaks-`));
  try {
    const entry = join(dir, "main.mjs");
    writeFileSync(entry, source);
    const outDir = join(cacheDir, name);
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
    return await execFileAsync(result.binaryPath, [], {
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!sanitize || process.platform !== "linux")(
  "SubtleCrypto method values under LeakSanitizer",
  () => {
    test("a caught refusal reports no leaks", { timeout: 300_000 }, async () => {
      const run = await runUnderLeakSanitizer(
        "webcrypto-subtle-value-leaks",
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
      expect(run.stdout).toBe("refused 100 function\n");
      expect(run.stderr).toBe("");
    });

    test("the digest value leaks nothing across calls", { timeout: 300_000 }, async () => {
      const run = await runUnderLeakSanitizer(
        "webcrypto-digest-value-leaks",
        "const { subtle } = globalThis.crypto;\n" +
          "const digest = subtle.digest;\n" +
          'for (let i = 0; i < 20; i++) await digest("SHA-256", new Uint8Array(1));\n' +
          'console.log("digests", 20);\n',
      );
      expect(run.stdout).toBe("digests 20\n");
      expect(run.stderr).toBe("");
    });
  },
);
