import { expect, test } from "vitest";
import {
  isTargetCpuOption,
  targetCpuAttribute,
  targetCpuField,
  targetCpuKeyParts,
  targetCpuTargetRefusal,
  x86Level,
} from "./target-cpu.js";

const V2 = ["cx16", "lahf_lm", "popcnt", "pni", "sse4_1", "sse4_2", "ssse3"];
const V3 = ["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"];
const V4 = ["avx512f", "avx512bw", "avx512cd", "avx512dq", "avx512vl"];
const level = (flags: string[]) => x86Level((flag) => flags.includes(flag));

test("a host's level is the highest one whose features and lower levels' features it has", () => {
  expect(level([])).toBe("baseline");
  expect(level(V2)).toBe("x86-64-v2");
  expect(level([...V2, ...V3])).toBe("x86-64-v3");
  expect(level([...V2, ...V3, ...V4])).toBe("x86-64-v4");
  // AVX-512 without BMI2 is still v2.
  expect(level([...V2, ...V3.filter((f) => f !== "bmi2"), ...V4])).toBe("x86-64-v2");
  expect(level([...V3, ...V4])).toBe("baseline");
});

test("the baseline adds no key part, attribute or option field", () => {
  for (const cpu of [undefined, "baseline"] as const) {
    expect(targetCpuKeyParts(cpu)).toEqual([]);
    expect(targetCpuAttribute(cpu)).toBe("");
    expect(targetCpuField(cpu)).toEqual({});
    expect(targetCpuTargetRefusal(cpu, "linux", "arm64")).toBeNull();
  }
  expect(targetCpuKeyParts("x86-64-v3")).toEqual(["target-cpu-x86-64-v3"]);
  expect(targetCpuAttribute("x86-64-v4")).toBe(' "target-cpu"="x86-64-v4"');
  expect(targetCpuField("x86-64-v2")).toEqual({ targetCpu: "x86-64-v2" });
});

test("a level is refused for targets that are not x86-64", () => {
  expect(targetCpuTargetRefusal("x86-64-v3", "linux", "x64")).toBeNull();
  expect(targetCpuTargetRefusal("x86-64-v3", "darwin", "arm64")).toBe(
    "--target-cpu=x86-64-v3 requires an x86-64 target",
  );
  expect(targetCpuTargetRefusal("x86-64-v3", "wasi", "x64")).not.toBeNull();
});

test("the option accepts the levels and native", () => {
  for (const value of ["baseline", "x86-64-v2", "x86-64-v3", "x86-64-v4", "native"])
    expect(isTargetCpuOption(value)).toBe(true);
  for (const value of ["x86-64", "haswell", "", undefined])
    expect(isTargetCpuOption(value)).toBe(false);
});
