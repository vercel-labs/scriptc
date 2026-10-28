import { expect, test } from "vitest";
import { executableLinkInputs } from "./link-plan-core.js";
import {
  parseNativeProfileMatch,
  nativeProfileHelperArgs,
  renderNativeProfileMatch,
  nativeProfileKey,
  nativeProfileLayout,
  nativeProfileRefusal,
  profileGenerateLinkerArgs,
  profileHasContextCounts,
  profileLayoutLinkerArgs,
} from "./native-profile.js";
import { NATIVE_TARGETS } from "./targets.js";

const BASE = {
  outputKind: "exe",
  optimization: "speed",
  sanitize: false,
  platform: "linux",
} as const;

test("profiles are accepted for optimized executables", () => {
  expect(nativeProfileRefusal(BASE)).toBeNull();
  expect(nativeProfileRefusal({ ...BASE, profileGenerate: "/p/%p.profraw" })).toBeNull();
  expect(nativeProfileRefusal({ ...BASE, profileUse: "/p/a.profdata" })).toBeNull();
  expect(
    nativeProfileRefusal({ ...BASE, optimization: "release", profileUse: "/p/a.profdata" }),
  ).toBeNull();
  expect(
    nativeProfileRefusal({ ...BASE, platform: "darwin", profileUse: "/p/a.profdata" }),
  ).toBeNull();
  // The second phase of a context-sensitive profile.
  expect(
    nativeProfileRefusal({
      ...BASE,
      profileGenerate: "/p/%p.profraw",
      profileUse: "/p/a.profdata",
    }),
  ).toBeNull();
});

test.each([
  [
    { profileGenerate: "/p/%p.profraw", profileUse: "/p/a.profdata", platform: "darwin" },
    /Linux executables/,
  ],
  [{ profileUse: "/p/a.profdata", outputKind: "obj" }, /--profile-use is only supported/],
  [{ profileGenerate: "/p/%p.profraw", sanitize: true }, /--sanitize/],
  [{ profileUse: "/p/a.profdata", optimization: "dev" }, /optimized build/],
  [{ profileGenerate: "/p/%p.profraw", platform: "darwin" }, /Linux executables/],
  [{ profileGenerate: "/p/%p.profraw", platform: "wasi" }, /Linux executables/],
] as const)("refuses %j", (override, message) => {
  expect(nativeProfileRefusal({ ...BASE, ...override })).toMatch(message);
});

test("helper arguments and cache keys name the profile", () => {
  expect(nativeProfileHelperArgs(undefined)).toEqual([]);
  expect(nativeProfileKey(undefined)).toBe("");
  expect(nativeProfileHelperArgs({ generate: "/p/%p.profraw" })).toEqual([
    "--profile-generate",
    "/p/%p.profraw",
  ]);
  expect(nativeProfileKey({ generate: "/p/%p.profraw" })).toBe("profile-generate:/p/%p.profraw");
  const use = { use: { path: "/p/a.profdata", digest: "d".repeat(64), contextSensitive: false } };
  expect(nativeProfileHelperArgs(use)).toEqual(["--profile-use", "/p/a.profdata"]);
  expect(nativeProfileKey(use)).toBe(`profile-use:${"d".repeat(64)}`);
  const both = { generate: "/p/%p.profraw", ...use };
  expect(nativeProfileHelperArgs(both)).toEqual([
    "--profile-generate",
    "/p/%p.profraw",
    "--profile-use",
    "/p/a.profdata",
  ]);
  expect(nativeProfileKey(both)).toBe(
    `profile-generate:/p/%p.profraw\0profile-use:${"d".repeat(64)}`,
  );
});

test("a profile's context-sensitive flag is read from its header", () => {
  const header = (last: number) =>
    Uint8Array.from([0xff, 0x6c, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x81, 12, 0, 0, 0, 0, 0, 0, last]);
  // VARIANT_MASK_IR_PROF (bit 56) alone, then with VARIANT_MASK_CSIR_PROF (bit 57).
  expect(profileHasContextCounts(header(0x01))).toBe(false);
  expect(profileHasContextCounts(header(0x03))).toBe(true);
  expect(profileHasContextCounts(header(0x03).slice(0, 15))).toBe(false);
  const raw = header(0x03);
  raw[0] = 0x00;
  expect(profileHasContextCounts(raw)).toBe(false);
});

test("only a context-sensitive profile lays out code and keeps its section kinds apart", () => {
  const use = (contextSensitive: boolean) => ({
    use: { path: "/p/a.profdata", digest: "d".repeat(64), contextSensitive },
  });
  expect(nativeProfileLayout(undefined)).toBe(false);
  expect(nativeProfileLayout(use(false))).toBe(false);
  expect(nativeProfileLayout(use(true))).toBe(true);
  expect(nativeProfileLayout({ generate: "/p/%p.profraw", ...use(true) })).toBe(false);
  const linux = { platform: "linux", defaultLinker: "clang" };
  expect(profileLayoutLinkerArgs(linux, true)).toEqual(["-Wl,-z,keep-text-section-prefix"]);
  expect(profileLayoutLinkerArgs(linux, false)).toEqual([]);
  expect(profileLayoutLinkerArgs({ platform: "darwin", defaultLinker: "clang" }, true)).toEqual([]);
  // Zig links cross-compiled and glibc-versioned Linux targets and rejects the flag.
  expect(profileLayoutLinkerArgs({ platform: "linux", defaultLinker: "zig" }, true)).toEqual([]);
});

test("only the instrumented link adds the profile runtime", () => {
  expect(profileGenerateLinkerArgs(false)).toEqual([]);
  expect(profileGenerateLinkerArgs(true)).toEqual(["-fprofile-generate"]);
  const target = NATIVE_TARGETS.find((candidate) => candidate.platform === "linux")!;
  const inputs = {
    target,
    programObject: "/p/program.o",
    ffiLibraries: [],
    ffiSystemLibraries: [],
    ffiFrameworks: [],
    runtimeObjects: [],
    runtimeArchives: [],
    runtimeSystemLibraries: [],
    optimization: "speed",
  } as const;
  expect(executableLinkInputs(inputs).driverFlags).not.toContain("-fprofile-generate");
  expect(executableLinkInputs({ ...inputs, profileGenerate: true }).driverFlags).toContain(
    "-fprofile-generate",
  );
});

test("the helper's profile match is read from its output", () => {
  expect(
    parseNativeProfileMatch(
      '{"ok":true,"profile":{"annotated":120,"mismatched":7,"missing":40,"unknown_partitions":1}}\n',
    ),
  ).toEqual({ annotated: 120, mismatched: 7, missing: 40, unknownPartitions: 1 });
  // A helper that predates the report prints nothing.
  expect(parseNativeProfileMatch("")).toBeNull();
  expect(parseNativeProfileMatch('{"ok":true}\n')).toBeNull();
  expect(parseNativeProfileMatch('{"ok":true,"profile":{"annotated":-1}}\n')).toBeNull();
});

test("the build reports the match, and warns when the profile is stale", () => {
  expect(
    renderNativeProfileMatch("app.profdata", {
      annotated: 9170,
      mismatched: 0,
      missing: 28636,
      unknownPartitions: 0,
    }),
  ).toBe(
    "scriptc: profile app.profdata: 9170 functions annotated, 0 mismatched, 28636 without a record\n",
  );
  // 10% of the described functions changed: at the threshold, no warning.
  expect(
    renderNativeProfileMatch("app.profdata", {
      annotated: 90,
      mismatched: 10,
      missing: 5,
      unknownPartitions: 1,
    }),
  ).toBe(
    "scriptc: profile app.profdata: 90 functions annotated, 10 mismatched, 5 without a record, 1 partition without counts\n",
  );
  expect(
    renderNativeProfileMatch("app.profdata", {
      annotated: 5208,
      mismatched: 3739,
      missing: 28859,
      unknownPartitions: 2,
    }),
  ).toBe(
    "scriptc: profile app.profdata: 5208 functions annotated, 3739 mismatched, 28859 without a record, 2 partitions without counts\n" +
      "scriptc: warning: 3739 of the 8947 functions app.profdata describes (41.8%) changed since it was collected and are optimized without their counts; collect the profile again\n",
  );
  // Nothing described: no share to warn about.
  expect(
    renderNativeProfileMatch("app.profdata", {
      annotated: 0,
      mismatched: 0,
      missing: 12,
      unknownPartitions: 0,
    }),
  ).toBe(
    "scriptc: profile app.profdata: 0 functions annotated, 0 mismatched, 12 without a record\n",
  );
});
