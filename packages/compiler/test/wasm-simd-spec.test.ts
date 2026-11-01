/* Official WebAssembly SIMD and relaxed SIMD modules with scalar wrappers.
 * The generator checks expected values in V8; corpus programs execute the
 * same assertions natively without converting vector values to JS. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { analyzeWasm } from "../src/wasm/binary.js";
import { translateWasmModule } from "../src/wasm/translate.js";

const spec = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../tests/wasm-spec/corpus/simd-spec.json"), "utf8"),
) as {
  groups: Record<string, { file: string; module: number; base64: string }[]>;
  invalid: { file: string; command: number; base64: string }[];
};
const sha = new Uint8Array(32);
const v8Validate = (bytes: Uint8Array): boolean =>
  (
    globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } }
  ).WebAssembly.validate(bytes);

describe("official SIMD specification modules", () => {
  for (const [group, modules] of Object.entries(spec.groups)) {
    test.each(modules)(`${group} $file module $module validates and lowers`, (fixture) => {
      const bytes = Buffer.from(fixture.base64, "base64");
      expect(v8Validate(bytes)).toBe(true);
      expect(analyzeWasm(bytes).status).toBe("valid");
      for (const boundsChecks of [false, true])
        expect(() => translateWasmModule(bytes, sha, { boundsChecks })).not.toThrow();
    });
  }
  test.each(spec.invalid)("rejects $file command $command", (fixture) => {
    const bytes = Buffer.from(fixture.base64, "base64");
    expect(v8Validate(bytes)).toBe(false);
    expect(analyzeWasm(bytes).status).toBe("invalid");
  });
});
