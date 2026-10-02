import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compileLibrary } from "@scriptc/compiler";

const sanitize = process.env["SCRIPTC_SAN"] === "1";
const outDir = join(import.meta.dirname, "../../node_modules/.cache/scriptc-tests/library-int-signed-zero-native", sanitize ? "san" : "plain");

test("signed-zero native f64 witnesses and safe integer clamps match Node", async () => {
  mkdirSync(outDir, { recursive: true });
  const bodies = {
    reciprocal: "if (z === 0) return Math.trunc(Math.min(1 / z, 1)); return 0;",
    power: "if (z === 0) return Math.trunc(Math.min(z ** -3, 1)); return 0;",
    bounded: "if (z === 0) return Math.trunc(Math.max(Math.min(1 / z, 1), -1)); return 0;",
  };
  const entry = join(outDir, "lib.ts");
  writeFileSync(entry, Object.entries(bodies).map(([name, body]) =>
    `export function ${name}(z: number): number { ${body} }`,
  ).join("\n"));
  const profilePath = join(outDir, "profile.json");
  writeFileSync(profilePath, JSON.stringify({
    profile_format: 1,
    name: "signed-zero-native",
    entry,
    emission: "llvm",
    abi: {
      prefix: "sz_",
      init_symbol: "sz_init",
      sink_register_symbol: "sz_set_panic_sink",
      collect_symbol: null,
      result_reset_symbol: null,
    },
    exports: Object.keys(bodies).map((name) => ({
      export: name,
      symbol: `sz_${name}`,
      params: ["f64"],
      // The one-sided expressions stay f64: their infinities cannot
      // legally cross an integer boundary. The two-sided clamp can.
      returns: name === "bounded" ? "i64" : "f64",
    })),
  }));
  const result = await compileLibrary({ profilePath, outDir, sanitize });
  if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));

  const probe = join(outDir, "probe.c");
  writeFileSync(probe, `
#include <inttypes.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
extern void sz_init(void);
extern void sz_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern double sz_reciprocal(double);
extern double sz_power(double);
extern int64_t sz_bounded(double);
static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  fprintf(stderr, "%.*s\\n", (int)len, (const char *)msg);
}
static void value(const char *name, const char *input, double x) {
  printf("%s %s ", name, input);
  if (isnan(x)) puts("NaN");
  else if (isinf(x)) puts(signbit(x) ? "-Infinity" : "Infinity");
  else if (x == 0 && signbit(x)) puts("-0");
  else printf("%.17g\\n", x);
}
int main(void) {
  const double inputs[] = {0.0, -0.0, 1.0};
  const char *labels[] = {"+0", "-0", "1"};
  sz_set_panic_sink(sink, NULL);
  sz_init();
  for (int i = 0; i < 3; ++i) value("reciprocal", labels[i], sz_reciprocal(inputs[i]));
  for (int i = 0; i < 3; ++i) value("power", labels[i], sz_power(inputs[i]));
  for (int i = 0; i < 3; ++i) printf("bounded %s %" PRId64 "\\n", labels[i], sz_bounded(inputs[i]));
  return 0;
}
`);
  const binary = join(outDir, "probe");
  execFileSync("clang", ["-std=c11", probe, result.archivePath, "-lm", ...(sanitize ? ["-fsanitize=address"] : []), "-o", binary]);
  const run = spawnSync(binary, [], { encoding: "utf8", timeout: 30_000 });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  const format = (value: number): string => Object.is(value, -0) ? "-0" : String(value);
  const inputs = [{ label: "+0", value: 0 }, { label: "-0", value: -0 }, { label: "1", value: 1 }];
  const expected = Object.entries(bodies).flatMap(([name, body]) => {
    const oracle = new Function("z", body) as (z: number) => number;
    return inputs.map(({ label, value }) => `${name} ${label} ${format(oracle(value))}\n`);
  }).join("");
  expect(run.stdout).toBe(expected);
});
