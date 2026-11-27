/* A certificate in untyped code keeps nothing behind once it is dropped.
 * The dynamic handle's own-property table is handed to the handle (adopted
 * and traced) when a program annotates or freezes a certificate, as the
 * fetch-style handles do; without that integration the side table keeps the
 * handle — and its DER and property graph — alive until the thread exits,
 * which the RC audit reports for a request-scoped certificate made in a
 * loop. Linux only (Apple's ASan has no LeakSanitizer); runs in the
 * SCRIPTC_SAN=1 lane. */
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

const PEM = `-----BEGIN CERTIFICATE-----
MIIDqjCCApKgAwIBAgICCwswDQYJKoZIhvcNAQELBQAwPjELMAkGA1UEBhMCVVMx
FDASBgNVBAoMC0V4YW1wbGUgT3JnMRkwFwYDVQQDDBBFeGFtcGxlIFJTQSBSb290
MCAXDTI2MTAyMjA5NDY0MVoYDzIxMjYwOTI4MDk0NjQxWjBfMQswCQYDVQQGEwJV
UzEUMBIGA1UECgwLRXhhbXBsZSBPcmcxGDAWBgNVBAMMD3d3dy5leGFtcGxlLmNv
bTEgMB4GCSqGSIb3DQEJARYRYWRtaW5AZXhhbXBsZS5jb20wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARidSirNIIrw+YHeS112z3N+1n0+uA9HjzkQ5u3QfZsRGCe
ivCEMQSs5+cUE/nv5WWda2kQWavxPGluHFtYmS10o4IBWDCCAVQwCQYDVR0TBAIw
ADALBgNVHQ8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMHsG
A1UdEQR0MHKCDSouZXhhbXBsZS5jb22CC2V4YW1wbGUuY29tghV4bi0tYmNoZXIt
a3ZhLmV4YW1wbGWBD29wc0BleGFtcGxlLmNvbYcECgAAAYcQIAENuAAAAAAAAAAA
AAAAAYYUaHR0cHM6Ly9leGFtcGxlLmNvbS8wXgYIKwYBBQUHAQEEUjBQMCQGCCsG
AQUFBzABhhhodHRwOi8vb2NzcC5leGFtcGxlLmNvbS8wKAYIKwYBBQUHMAKGHGh0
dHA6Ly9jYS5leGFtcGxlLmNvbS9jYS5jcnQwHQYDVR0OBBYEFHyUnRTDwZxUPVwZ
RKmse3fjoeMMMB8GA1UdIwQYMBaAFAgaWVveRbA7VKqcHzjMqBPzi1/LMA0GCSqG
SIb3DQEBCwUAA4IBAQAfMTcpidoH47PXOQVxRttfrG7K9BcntyXP4+5hUAoSfMr6
Rxy7X/9ba7R0yCGlNsUCusObaBpbdvwX8v9TiTYKVL+C9rEVGrTHnh6kbgZaaCQc
L3oWbfRrYnEBYuSlFuadjVvX42aqzHV28E4ITgywCxwubu2hAbacbcUHpnRSqLDq
lV+VZSQA/6cPNct7PR6AkJU80D+5wVOk7RVi4rsfbw1wFDeksCHu+0EThs9zjzL+
S7HTCjB6AOHpbu1Sx+0d5YEKSE7EPF+dSFATNbhjTHzYQySnHK+Lm8nON8wmY1rC
7opOhvUlid1jA1d2BKO2ZxlxLir4pyIehTC1ddG2
-----END CERTIFICATE-----
`;

describe.skipIf(!sanitize || process.platform !== "linux")(
  "a dropped dynamic certificate in the LeakSanitizer lane",
  () => {
    test("annotated and frozen certificates report no leaks", { timeout: 300_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-x509-dyn-leaks-"));
      try {
        const entry = join(dir, "main.mjs");
        writeFileSync(
          entry,
          [
            'import { X509Certificate } from "node:crypto";',
            "",
            "const PEM = `" + PEM + "`;",
            "",
            "// The Date write makes the program add properties to handles, which",
            "// installs the handle-property unit: the certificate's own table is",
            "// then the side table this checks.",
            "const clock = new Date(0);",
            "clock.marker = 1;",
            "let annotated = 0;",
            "for (let i = 0; i < 50; i++) {",
            "  const cert = new X509Certificate(PEM);",
            "  const held = cert;",
            "  try {",
            "    Object.freeze(held);",
            "  } catch (e) {",
            "    // a refused freeze still went through the table",
            "  }",
            "  annotated++;",
            "}",
            'console.log("annotated", annotated, "clock", clock.getTime());',
            "",
          ].join("\n"),
        );
        const outDir = join(cacheDir, "x509-dynamic-value-leaks");
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
        expect(run.stdout).toBe("annotated 50 clock 0\n");
        expect(run.stderr).toBe("");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
