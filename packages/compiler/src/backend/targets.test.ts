import { afterEach, describe, expect, test, vi } from "vitest";
import {
  IOS_ARM64_TARGET,
  IOS_SIMULATOR_ARM64_TARGET,
  ANDROID_ARM64_TARGET,
  nativeHelperForTarget,
  LINUX_ARM64_GNU_TARGET,
  LINUX_ARM64_MUSL_TARGET,
  LINUX_X64_GNU_TARGET,
  LINUX_X64_MUSL_TARGET,
  MACOS_ARM64_TARGET,
  MACOS_X64_TARGET,
  WASM32_WASI_TARGET,
  WINDOWS_X64_MSVC_TARGET,
  executableOptimizationLinkerArgs,
  executableStaticLinkerArgs,
  ffiExtendsNarrowIntegers,
  nativeCodegenTarget,
  nativeCodegenTargetRefusal,
  selectNativeTarget,
  staticExecutableRefusal,
  staticLinkFailureNote,
  staticLinkMapArgs,
  staticLinkRefusal,
  windowsSubsystemLinkerArgs,
} from "./targets.js";

afterEach(() => vi.restoreAllMocks());

describe("native code-generation targets", () => {
  test("non-Linux and unsupported hosts never collect a process report", async () => {
    vi.resetModules();
    const targets = await import("./targets.js");
    const report = vi.spyOn(process.report, "getReport").mockImplementation(() => {
      throw new Error("unexpected host libc probe");
    });
    for (const [platform, arch, release] of [
      ["darwin", "arm64", "24.0.0"],
      ["darwin", "x64", "24.0.0"],
      ["win32", "x64", "10.0.0"],
    ] as const) {
      expect(targets.nativeCodegenTarget({}, platform, arch, release)).not.toBeNull();
      expect(targets.nativeCodegenTargetRefusal({}, platform, arch, release)).toBeNull();
      expect(targets.nativeHelperForTarget(LINUX_X64_GNU_TARGET, platform, arch)).not.toBeNull();
    }
    expect(targets.nativeCodegenTarget({}, "linux", "ia32", "6.8.0")).toBeNull();
    expect(targets.nativeHelperForTarget(LINUX_X64_GNU_TARGET, "linux", "ia32")).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  test.each(["gnu", "musl"] as const)(
    "probes the %s host libc once across target and helper selection",
    async (libc) => {
      vi.resetModules();
      const targets = await import("./targets.js");
      const report = vi.spyOn(process.report, "getReport").mockReturnValue({
        header: libc === "gnu" ? { glibcVersionRuntime: "2.36" } : {},
      } as ReturnType<typeof process.report.getReport>);
      const target = libc === "gnu" ? LINUX_X64_GNU_TARGET : LINUX_X64_MUSL_TARGET;
      expect(targets.nativeCodegenTarget({}, "linux", "x64", "6.8.0")).toEqual(target);
      expect(targets.nativeCodegenTargetRefusal({}, "linux", "x64", "6.8.0")).toBeNull();
      expect(targets.nativeHelperForTarget(target, "linux", "x64")?.packageName).toBe(
        `@scriptc/llvm-linux-x64-${libc}`,
      );
      expect(
        targets.nativeCodegenTarget({ SCRIPTC_TARGET: "wasm32-wasi" }, "linux", "x64", "6.8.0"),
      ).toEqual(WASM32_WASI_TARGET);
      expect(report).toHaveBeenCalledTimes(1);

      // Explicit host descriptions remain independent of the process memo.
      expect(targets.nativeCodegenTarget({}, "linux", "x64", "6.8.0", "gnu")).toEqual(
        LINUX_X64_GNU_TARGET,
      );
      expect(targets.nativeCodegenTarget({}, "linux", "x64", "6.8.0", "musl")).toEqual(
        LINUX_X64_MUSL_TARGET,
      );
      expect(report).toHaveBeenCalledTimes(1);
    },
  );

  test("matches Clang's narrow integer ABI independently of the build host", () => {
    for (const target of [
      MACOS_ARM64_TARGET,
      MACOS_X64_TARGET,
      LINUX_X64_GNU_TARGET,
      LINUX_X64_MUSL_TARGET,
      WASM32_WASI_TARGET,
    ]) {
      expect(ffiExtendsNarrowIntegers(target.llvmTriple, "win32", "x64")).toBe(true);
    }
    for (const target of [
      LINUX_ARM64_GNU_TARGET,
      LINUX_ARM64_MUSL_TARGET,
      WINDOWS_X64_MSVC_TARGET,
    ]) {
      expect(ffiExtendsNarrowIntegers(target.llvmTriple, "darwin", "arm64")).toBe(false);
    }
    expect(ffiExtendsNarrowIntegers("aarch64-apple-ios", "linux", "arm64")).toBe(true);
    expect(ffiExtendsNarrowIntegers("aarch64-macos", "linux", "arm64")).toBe(true);
    expect(ffiExtendsNarrowIntegers("aarch64-linux-android", "darwin", "arm64")).toBe(false);
    expect(ffiExtendsNarrowIntegers(undefined, "darwin", "arm64")).toBe(true);
    expect(ffiExtendsNarrowIntegers(undefined, "linux", "x64")).toBe(true);
    expect(ffiExtendsNarrowIntegers(undefined, "linux", "arm64")).toBe(false);
    expect(ffiExtendsNarrowIntegers(undefined, "win32", "x64")).toBe(false);
  });

  test("selects only fully specified host-native targets", () => {
    expect(nativeCodegenTarget({}, "darwin", "arm64", "24.0.0")).toEqual(MACOS_ARM64_TARGET);
    expect(nativeCodegenTarget({}, "darwin", "x64", "24.0.0")).toEqual(MACOS_X64_TARGET);
    expect(nativeCodegenTarget({}, "linux", "x64", "6.8.0", "gnu")).toEqual(LINUX_X64_GNU_TARGET);
    expect(nativeCodegenTarget({}, "linux", "arm64", "6.8.0", "gnu")).toEqual(
      LINUX_ARM64_GNU_TARGET,
    );
    expect(nativeCodegenTarget({}, "linux", "x64", "6.8.0", "musl")).toEqual(LINUX_X64_MUSL_TARGET);
    expect(nativeCodegenTarget({}, "linux", "arm64", "6.8.0", "musl")).toEqual(
      LINUX_ARM64_MUSL_TARGET,
    );
    expect(nativeCodegenTarget({}, "win32", "x64", "10.0.0")).toEqual(WINDOWS_X64_MSVC_TARGET);
    expect(nativeCodegenTarget({}, "darwin", "arm64", "23.6.0")).toBeNull();
    expect(nativeCodegenTarget({}, "linux", "ia32", "6.8.0")).toBeNull();
    expect(
      nativeCodegenTarget({ SCRIPTC_TARGET: "x86_64-linux-musl" }, "linux", "x64", "6.8.0", "musl"),
    ).toEqual(LINUX_X64_MUSL_TARGET);
    expect(
      nativeCodegenTarget(
        { SCRIPTC_TARGET: "aarch64-linux-musl" },
        "linux",
        "arm64",
        "6.8.0",
        "musl",
      ),
    ).toEqual(LINUX_ARM64_MUSL_TARGET);
    expect(
      nativeCodegenTarget({ SCRIPTC_TARGET: "wasm32-wasi" }, "darwin", "x64", "24.0.0"),
    ).toEqual(WASM32_WASI_TARGET);
    expect(
      nativeCodegenTarget({ SCRIPTC_TARGET: "aarch64-apple-ios" }, "darwin", "arm64", "24.0.0"),
    ).toEqual(IOS_ARM64_TARGET);
  });

  test("refusals name the unsupported host or cross target", () => {
    expect(nativeCodegenTargetRefusal({}, "linux", "ia32", "6.8.0")).toContain("linux ia32");
    expect(nativeCodegenTargetRefusal({}, "darwin", "arm64", "23.6.0")).toContain(
      "requires macOS 15.0 or newer",
    );
    expect(
      nativeCodegenTargetRefusal(
        { SCRIPTC_TARGET: "riscv64-linux-gnu" },
        "darwin",
        "arm64",
        "24.0.0",
      ),
    ).toContain("SCRIPTC_TARGET=riscv64-linux-gnu");
  });

  test("cross targets select the host helper and a target linker", () => {
    const cross = nativeCodegenTarget(
      { SCRIPTC_TARGET: "x86_64-linux-gnu.2.36" },
      "darwin",
      "arm64",
      "24.0.0",
    )!;
    expect(cross).toMatchObject({
      name: "linux-x64-gnu",
      defaultLinker: "zig",
      linkerTargetTriple: "x86_64-linux-gnu.2.36",
    });
    expect(nativeHelperForTarget(cross, "darwin", "arm64")?.packageName).toBe(
      "@scriptc/llvm-darwin-arm64",
    );
    expect(nativeHelperForTarget(MACOS_ARM64_TARGET, "win32", "x64")?.packageName).toBe(
      "@scriptc/llvm-win32-x64-msvc",
    );
    expect(
      nativeCodegenTarget({ SCRIPTC_TARGET: "aarch64-linux-android" }, "win32", "x64", "10.0.0"),
    ).toEqual(ANDROID_ARM64_TARGET);
    expect(
      nativeCodegenTarget(
        { SCRIPTC_TARGET: "aarch64-apple-ios-simulator" },
        "darwin",
        "arm64",
        "24.0.0",
      ),
    ).toEqual(IOS_SIMULATOR_ARM64_TARGET);
    for (const target of [IOS_ARM64_TARGET, IOS_SIMULATOR_ARM64_TARGET, ANDROID_ARM64_TARGET]) {
      expect(target.supports).toEqual({ asm: true, obj: true, exe: false, library: true });
    }
  });

  test.each(["x64", "arm64"])(
    "GNU %s release links honor an explicit libc floor on the same host",
    (architecture) => {
      const triple = `${architecture === "x64" ? "x86_64" : "aarch64"}-linux-gnu.2.34`;
      expect(
        nativeCodegenTarget({ SCRIPTC_TARGET: triple }, "linux", architecture, "6.8.0", "gnu"),
      ).toMatchObject({
        minimumOs: "glibc 2.34",
        defaultLinker: "zig",
        defaultLinkerArgs: ["cc"],
        linkerTargetTriple: triple,
      });
      expect(
        nativeCodegenTarget(
          { SCRIPTC_TARGET: triple.replace(".2.34", "") },
          "darwin",
          "arm64",
          "24.0.0",
        ),
      ).toMatchObject({ minimumOs: "glibc 2.34", linkerTargetTriple: triple });
    },
  );

  test("owns helper executable linker arguments in the target specification", () => {
    expect(MACOS_ARM64_TARGET.executableLinkerArgs).toEqual([
      "-target",
      "arm64-apple-macosx14.0.0",
      "-pthread",
      "-Wl,-dead_strip",
    ]);
  });

  test("describes the WASI relocatable-object ABI", () => {
    expect(WASM32_WASI_TARGET.supports).toMatchObject({ asm: true, obj: true, exe: true });
  });

  test("strips WASI debug payload only from release executables", () => {
    expect(executableOptimizationLinkerArgs("wasi", "release")).toEqual(["-Wl,--strip-debug"]);
    expect(executableOptimizationLinkerArgs("wasi", "dev")).toEqual([]);
    expect(executableOptimizationLinkerArgs("linux", "release")).toEqual([]);
  });

  test("selects the PE GUI subsystem without changing default console links", () => {
    expect(windowsSubsystemLinkerArgs("win32", undefined)).toEqual([]);
    expect(windowsSubsystemLinkerArgs("win32", "console")).toEqual([]);
    expect(windowsSubsystemLinkerArgs("win32", "gui")).toEqual(["-Wl,--subsystem,windows"]);
    expect(() => windowsSubsystemLinkerArgs("linux", "gui")).toThrow("Windows executable target");
    expect(() => windowsSubsystemLinkerArgs("win32", "other" as "gui")).toThrow(
      "unknown Windows subsystem",
    );
  });

  test("links host glibc executables as static PIE only for --static", () => {
    expect(executableStaticLinkerArgs(LINUX_X64_GNU_TARGET, false)).toEqual([]);
    expect(executableStaticLinkerArgs(LINUX_X64_GNU_TARGET, true)).toEqual(["-static-pie"]);
    expect(executableStaticLinkerArgs(LINUX_ARM64_GNU_TARGET, true)).toEqual(["-static-pie"]);
    // musl executables are static already.
    expect(executableStaticLinkerArgs(LINUX_X64_MUSL_TARGET, true)).toEqual([]);
    expect(executableStaticLinkerArgs(MACOS_ARM64_TARGET, false)).toEqual([]);
    expect(() => executableStaticLinkerArgs(MACOS_ARM64_TARGET, true)).toThrow(
      "only supported for Linux executables",
    );
  });

  test("refuses --static where glibc cannot be linked statically", () => {
    const request = { staticLink: true, outputKind: "exe", sanitize: false };
    expect(staticLinkRefusal({ ...request, staticLink: undefined, target: null })).toBeNull();
    expect(staticLinkRefusal({ ...request, target: LINUX_X64_GNU_TARGET })).toBeNull();
    expect(staticLinkRefusal({ ...request, target: LINUX_X64_MUSL_TARGET })).toBeNull();
    expect(staticLinkRefusal({ ...request, outputKind: "obj", target: LINUX_X64_GNU_TARGET })).toBe(
      "--static is only supported for executable output",
    );
    expect(staticLinkRefusal({ ...request, sanitize: true, target: LINUX_X64_GNU_TARGET })).toMatch(
      "cannot be combined with --sanitize",
    );
    for (const target of [MACOS_ARM64_TARGET, WINDOWS_X64_MSVC_TARGET, WASM32_WASI_TARGET, null])
      expect(staticLinkRefusal({ ...request, target })).toBe(
        "--static is only supported for Linux executables",
      );
    // zig links cross-compiled glibc targets, and links glibc dynamically.
    const cross = selectNativeTarget("aarch64-linux-gnu", LINUX_X64_GNU_TARGET, "linux")!;
    expect(staticLinkRefusal({ ...request, target: cross })).toMatch("<arch>-linux-musl");
    const crossMusl = selectNativeTarget("aarch64-linux-musl", LINUX_X64_GNU_TARGET, "linux")!;
    expect(staticLinkRefusal({ ...request, target: crossMusl })).toBeNull();
  });

  test("refuses static glibc executables whose link map keeps the NSS loader", () => {
    const libc = "/lib/x86_64-linux-gnu/libc.a";
    // lld lists the input sections it kept.
    const lld = (member: string) =>
      [
        "             VMA              LMA     Size Align Out     In      Symbol",
        `          11e1a0           11e1a0      640    16         ${libc}(${member}):(.text)`,
        `          11e7e0           11e7e0       38     1         ${libc}(${member}):(.rodata)`,
      ].join("\n");
    const lldPlain = [
      "             VMA              LMA     Size Align Out     In      Symbol",
      `          2c62c0           2c62c0      a10    16         ${libc}(dl-open.o):(.text)`,
    ].join("\n");
    // GNU ld lists discarded sections first, and sections relaxation emptied with size 0.
    const bfd = (text: boolean) =>
      [
        "Discarded input sections",
        "",
        ` .text          0x0000000000000000      0x640 ${libc}(nss_module.o)`,
        "",
        "Linker script and memory map",
        "",
        ` .eh_frame      0x00000000000db750        0x0 ${libc}(nss_module.o)`,
        "                                        0x1b8 (size before relaxing)",
        ...(text ? [` .text          0x00000000000a81b0      0x640 ${libc}(nsswitch.o)`] : []),
      ].join("\n");
    const refusal =
      /^--static cannot link this program: its executable includes host, user or group name lookups/;
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, true, lld("nss_module.o"))).toMatch(
      refusal,
    );
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, true, lld("nsswitch.o"))).toMatch(refusal);
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, true, bfd(true))).toMatch(refusal);
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, true, bfd(false))).toBeNull();
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, true, lldPlain)).toBeNull();
    // A program's own string never counts.
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, true, "libnss_files.so.2")).toBeNull();
    expect(staticExecutableRefusal(LINUX_X64_GNU_TARGET, false, lld("nss_module.o"))).toBeNull();
    expect(staticExecutableRefusal(LINUX_X64_MUSL_TARGET, true, lld("nss_module.o"))).toBeNull();
  });

  test("writes a link map only for --static glibc links", () => {
    expect(staticLinkMapArgs(LINUX_X64_GNU_TARGET, true, "/stage/link.map")).toEqual([
      "-Xlinker",
      "-Map",
      "-Xlinker",
      "/stage/link.map",
    ]);
    expect(staticLinkMapArgs(LINUX_X64_GNU_TARGET, false, "/stage/link.map")).toEqual([]);
    expect(staticLinkMapArgs(LINUX_X64_MUSL_TARGET, true, "/stage/link.map")).toEqual([]);
  });

  test("notes glibc's static libraries on failed --static links", () => {
    expect(staticLinkFailureNote(LINUX_X64_GNU_TARGET, true)).toMatch("libc.a");
    expect(staticLinkFailureNote(LINUX_X64_GNU_TARGET, false)).toBe("");
    expect(staticLinkFailureNote(LINUX_X64_MUSL_TARGET, true)).toBe("");
  });
});
