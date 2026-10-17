import { expect, test } from "vitest";
import { runtimeHardeningFlags } from "../scripts/hardening.mjs";

const portable = [
  "-ftrivial-auto-var-init=zero",
  "-ftrivial-auto-var-init-max-size=64",
  "-fsanitize=bounds",
  "-fsanitize-trap=bounds",
];
const fortify = ["-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=2"];

test.each([
  [
    "glibc Linux",
    { platform: "linux", runtimeDefines: ["_GNU_SOURCE"] },
    [...portable, "-fstack-protector-strong", "-fstack-clash-protection", ...fortify],
  ],
  [
    "musl Linux",
    { platform: "linux", runtimeDefines: ["_GNU_SOURCE", "SCR_MUSL"] },
    [...portable, "-fstack-protector-strong", "-fstack-clash-protection"],
  ],
  ["Darwin", { platform: "darwin" }, [...portable, "-fstack-protector-strong", ...fortify]],
  ["Windows", { platform: "win32" }, [...portable, "-fstack-protector-strong", ...fortify]],
  ["WASI", { platform: "wasi", runtimeDefines: ["_GNU_SOURCE"] }, portable],
])("hardens optimized %s runtime units", (_name, config, flags) => {
  expect(runtimeHardeningFlags(config, { optimized: true })).toEqual(flags);
});

test("unoptimized units omit FORTIFY, which requires optimization", () => {
  const flags = runtimeHardeningFlags({ platform: "linux" }, { optimized: false });
  expect(flags).toContain("-fstack-protector-strong");
  expect(flags.some((flag) => flag.includes("FORTIFY"))).toBe(false);
});

test("bounds checks trap instead of calling a sanitizer runtime", () => {
  for (const platform of ["linux", "darwin", "win32", "wasi"]) {
    const flags = runtimeHardeningFlags({ platform }, { optimized: true });
    expect(flags.indexOf("-fsanitize-trap=bounds")).toBeGreaterThan(
      flags.indexOf("-fsanitize=bounds"),
    );
  }
});
