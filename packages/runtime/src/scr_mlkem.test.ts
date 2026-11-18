import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

// The vendored mlkem-native core against Node's cross-implementation
// vectors: the seed Node's PKCS#8 carries must derive Node's SPKI public
// key, and decapsulating Node's ciphertext must give Node's shared secret.
// The C backend is compiled once per parameter set, as the runtime pack
// does.
test.each([512, 768, 1024])("mlkem-native reproduces Node's ML-KEM-%d vectors", async (level) => {
  const scratch = await mkdtemp(join(tmpdir(), "scriptc-mlkem-"));
  try {
    const binary = join(scratch, `mlkem-${level}`);
    const vendor = join(import.meta.dirname, "..", "vendor", "mlkem-native");
    await exec("clang", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-function",
      `-DMLK_CONFIG_PARAMETER_SET=${level}`,
      `-DMLK_TEST_LEVEL=${level}`,
      "-I",
      vendor,
      "-I",
      join(vendor, "src"),
      join(import.meta.dirname, "scr_mlkem.test.c"),
      join(vendor, "mlkem_native.c"),
      "-o",
      binary,
    ]);
    const result = await exec(binary, []);
    expect(result.stdout).toBe(`mlkem-${level} KAT passed\n`);
    expect(result.stderr).toBe("");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
