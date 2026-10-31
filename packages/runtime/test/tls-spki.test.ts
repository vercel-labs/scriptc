import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native/runtime-inputs.js";

const execFileAsync = promisify(execFile);
const runtime = resolve(import.meta.dirname, "../src");
const vendor = resolve(import.meta.dirname, "../vendor/mbedtls");
const certs = resolve(import.meta.dirname, "../../../tests/fixtures/server/certs");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
let scratch: string | undefined;
let binary: string;

const certificateHashes = {
  "localhost.pem": "2a9c76908689622d7a43945815c3dc5ac16b7ccc194ce008965ea2f105e7a00d",
  "ca.pem": "a07682c2d5ad31a3aafb979155e43599294b48d638a167b3c94f0e238e978ee8",
  "ca2.pem": "dc6bc4c701bde02ccedfda1e844fdbc4f2e8b6daf41826abc8363d367f5e484b",
  "client.pem": "093839b9cb267a700eebcd46aa1963a46efb3cec248debb0e4e834ef53320792",
  "intermediate.pem": "651ac238b952fd4a64c96a3975f8d2ff788058e57dc1bfeecd0e095a8a659d63",
  "intermediate-localhost.pem": "e38f7e1eed35426b1f9421dbbdea6901fd03d43cc828889b1cd8ae2bd7a69a56",
};

const cases = [
  "valid",
  "blocked-leaf-required",
  "blocked-leaf-optional",
  "blocked-intermediate",
  "blocked-selected-root",
  "blocked-unused-anchor",
  "unrelated-blocked-peer-valid",
  "unrelated-blocked-peer-invalid-required",
  "unrelated-blocked-peer-invalid-optional",
  "server-secondary-eku",
  "server-secondary-eku-required",
  "hostname-only",
  "valid-client",
  "blocked-client-required",
  "blocked-client-optional",
  "hash-error",
  "client-secondary-eku",
  "verify-none",
];

// Use the executable runtime's source recipe, including its checked-dynamic
// core. scr_tls.c is included only by the test TU, keeping the SHA interposer
// out of the vendor's real certificate verification and handshake crypto.
beforeAll(async () => {
  for (const [name, expected] of Object.entries(certificateHashes)) {
    expect(
      createHash("sha256")
        .update(await readFile(join(certs, name)))
        .digest("hex"),
      name,
    ).toBe(expected);
  }
  scratch = await mkdtemp(join(tmpdir(), "scriptc-tls-spki-"));
  binary = join(scratch, "test_tls_spki");
  const tlsSources = (await readdir(join(vendor, "library")))
    .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
    .sort();
  await execFileAsync(
    "clang",
    [
      "-std=c11",
      sanitize ? "-O1" : "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-missing-field-initializers",
      "-Wno-deprecated-declarations",
      "-fno-math-errno",
      "-fno-strict-aliasing",
      "-ffunction-sections",
      "-fdata-sections",
      "-pthread",
      "-DSCR_RC_AUDIT",
      ...(sanitize ? ["-fsanitize=address,undefined"] : []),
      "-I",
      runtime,
      "-I",
      join(vendor, "include"),
      "-I",
      join(vendor, "library"),
      join(import.meta.dirname, "test_tls_spki.c"),
      ...[
        ...EXECUTABLE_RUNTIME_SOURCES,
        "scr_dyn_handle.c",
        "scr_loop_kqueue.c",
        "scr_loop_epoll.c",
        "scr_loop_wsapoll.c",
        "scr_net.c",
        "scr_tls_ca.c",
      ].map((name) => join(runtime, name)),
      ...tlsSources.map((name) => join(vendor, "library", name)),
      ...(process.platform === "linux"
        ? ["-D_GNU_SOURCE", "-lgcc_eh", "-lm", "-Wl,--gc-sections"]
        : ["-Wl,-dead_strip"]),
      "-o",
      binary,
    ],
    { timeout: 300_000 },
  );
}, 310_000);

afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

test("TLS SPKI policy controls", async () => {
  const { stdout, stderr } = await execFileAsync(binary, ["policy-controls", "0", certs], {
    timeout: 30_000,
    env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
  });
  expect(stdout).toBe("");
  expect(stderr).toBe("PASS policy-controls\n");
}, 35_000);

test.each(cases.flatMap((name) => [12, 13].map((version) => ({ name, version }))))(
  "TLS SPKI $name version $version",
  async ({ name, version }) => {
    const { stdout, stderr } = await execFileAsync(binary, [name, String(version), certs], {
      timeout: 30_000,
      env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
    });
    expect(stdout).toBe("");
    expect(stderr).toBe(`PASS ${name} TLS1.${version - 10}\n`);
  },
  35_000,
);
