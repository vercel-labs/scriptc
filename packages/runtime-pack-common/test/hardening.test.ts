import { expect, test } from "vitest";
import { probeHardeningSupport, runtimeHardeningFlags } from "../scripts/hardening.mjs";

const zeroInit = ["-ftrivial-auto-var-init=zero", "-ftrivial-auto-var-init-max-size=64"];
const bounds = ["-fsanitize=bounds", "-fsanitize-trap=bounds"];
const portable = [...zeroInit, ...bounds];
const fortify = ["-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=2"];
const supported = { cappedZeroInit: true };

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
  expect(runtimeHardeningFlags(config, { optimized: true, ...supported })).toEqual(flags);
});

test("unoptimized units omit FORTIFY, which requires optimization", () => {
  const flags = runtimeHardeningFlags({ platform: "linux" }, { optimized: false, ...supported });
  expect(flags).toContain("-fstack-protector-strong");
  expect(flags.some((flag) => flag.includes("FORTIFY"))).toBe(false);
});

test("unoptimized units check only local bounds, which embed no source paths", () => {
  // array-bounds metadata (file names, unnamed struct locations) survives -O0.
  expect(runtimeHardeningFlags({ platform: "darwin" }, { optimized: false, ...supported })).toEqual(
    [
      ...zeroInit,
      "-fsanitize=local-bounds",
      "-fsanitize-trap=local-bounds",
      "-fstack-protector-strong",
    ],
  );
});

test("bounds checks trap instead of calling a sanitizer runtime", () => {
  for (const platform of ["linux", "darwin", "win32", "wasi"]) {
    const flags = runtimeHardeningFlags({ platform }, { optimized: true, ...supported });
    expect(flags.indexOf("-fsanitize-trap=bounds")).toBeGreaterThan(
      flags.indexOf("-fsanitize=bounds"),
    );
  }
});

test("a compiler without the zero-init size cap gets no zero-initialization", () => {
  // Android NDK 27 clang: unlimited zero-initialization is not a fallback.
  const flags = runtimeHardeningFlags(
    { platform: "linux", runtimeDefines: ["_GNU_SOURCE"] },
    { optimized: true, cappedZeroInit: false },
  );
  expect(flags.some((flag) => flag.startsWith("-ftrivial-auto-var-init"))).toBe(false);
  expect(flags).toEqual([
    ...bounds,
    "-fstack-protector-strong",
    "-fstack-clash-protection",
    ...fortify,
  ]);
});

test("flag selection requires the probed compiler support", () => {
  expect(() => runtimeHardeningFlags({ platform: "linux" }, { optimized: true })).toThrow(
    /cappedZeroInit/,
  );
});

// Stand-in compilers: Node runs the script with the compile arguments after `--`.
const fakeCompiler = (script: string) => ({
  compiler: process.execPath,
  args: ["-e", script, "--"],
});

test("the probe reports the zero-init size cap when the compiler accepts it", async () => {
  await expect(probeHardeningSupport(fakeCompiler("process.exit(0)"))).resolves.toEqual({
    cappedZeroInit: true,
  });
});

test("the probe reports a missing zero-init size cap", async () => {
  const rejectsCap = `process.exit(process.argv.some((a) => a.startsWith("-ftrivial-auto-var-init-max-size")) ? 1 : 0)`;
  await expect(probeHardeningSupport(fakeCompiler(rejectsCap))).resolves.toEqual({
    cappedZeroInit: false,
  });
});

test("a probe that cannot compile at all fails instead of reporting no support", async () => {
  await expect(probeHardeningSupport(fakeCompiler("process.exit(1)"))).rejects.toThrow();
});
