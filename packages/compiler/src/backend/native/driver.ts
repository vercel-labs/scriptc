import {
  IPHONEOS_MIN_VERSION,
  ANDROID_MIN_API,
  isIosTarget,
  isAndroidTarget,
  mobileTargetRefusal,
  configuredTargetPlatform,
} from "../target-platform.js";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-target section-elimination recipe. This belongs beside the native
 * driver rather than a particular build path: one-shot compilation, cached
 * runtime objects, external object recipes, and runtime packs must all agree
 * on what their final linker is allowed to discard.
 *
 * Executable recipes use both halves. Archive and compile-only recipes never
 * use the link half, but `--lib` uses the compile half so its consumers retain
 * the choice to eliminate unused sections when they perform the final link.
 */
export function executableSectionEliminationFlags(platform: string): {
  compile: string[];
  link: string[];
} {
  switch (platform) {
    case "darwin":
      // ld64's symbol subsections let dead_strip remove unreachable runtime code.
      return { compile: [], link: ["-Wl,-dead_strip"] };
    case "linux":
      return {
        compile: ["-ffunction-sections", "-fdata-sections"],
        link: ["-Wl,--gc-sections"],
      };
    case "win32":
      // clang's MinGW driver forwards this to GNU-flavor ld/lld. A direct
      // local lld-link invocation instead uses /OPT:REF, but scriptc only
      // drives the compiler's GNU-flavor route here.
      return {
        compile: ["-ffunction-sections", "-fdata-sections"],
        link: ["-Wl,--gc-sections"],
      };
    // WASI has a distinct linker/runtime contract. Keep its existing object
    // layout until its linker invocation is validated separately.
    default:
      return { compile: [], link: [] };
  }
}

export interface CcDriver {
  /** The compiler argv prefix: ["clang"] (default) or ["zig", "cc"]. */
  argv: string[];
  /** The SCRIPTC_TARGET triple, or null for a host-native build. */
  target: string | null;
  /** The spelling handed to `zig cc -target` (and the relocatable-merge
   * link). Identical to `target` except for the mobile triples, whose
   * canonical LLVM spellings map to zig's own (`aarch64-apple-ios` →
   * `aarch64-ios.15.0`), pinning the minimum OS version in the same
   * breath. Null for a host-native build. */
  zigTarget: string | null;
  /** Extra compile args the produced platform demands. */
  targetArgs: string[];
  /** Platform libraries appended after every object/archive input. */
  linkArgs: string[];
}

/** Whether the selected compiler driver is Zig. This is deliberately based on
 * the executable prefix rather than target presence: targetless Zig is still
 * a Zig build, while target presence is only the platform/target contract. */
export function isZigDriver(driver: Pick<CcDriver, "argv">): boolean {
  return driver.argv[0] === "zig";
}

/* ── mobile targets (library mode) ─────────────────────────────────────────
 * Three mobile triples are admitted, and only for LIBRARY-MODE archive
 * builds — the consuming pattern is an embedding app linking the archive,
 * never a standalone executable (compile()/compileC refuse the executable
 * lane with the pointer to --lib):
 *
 *   aarch64-apple-ios            device archives; zig `aarch64-ios.15.0`
 *   aarch64-apple-ios-simulator  simulator archives; zig
 *                                `aarch64-ios.15.0-simulator`
 *   aarch64-linux-android        zig `aarch64-linux-android.26`
 *
 * The minimum-version floors are part of the target contract: iOS archives
 * build for iOS 15.0 (IPHONEOS_MIN_VERSION), Android archives for API level
 * 26 (ANDROID_MIN_API) — LC_BUILD_VERSION minos and the bionic stub level
 * both come from the pinned zig spelling above, so an embedder's deployment
 * target at or above the floor links cleanly.
 *
 * Zig bundles no Apple or bionic libc, so both families compile against an
 * explicit sysroot discovered here and spelled into targetArgs (where every
 * cache tier already keys it):
 *
 *   iOS      darwin hosts only — `xcrun --show-sdk-path` selects the
 *            iPhoneOS/iPhoneSimulator SDK; compiles add `-isysroot <sdk>`
 *            plus `-isystem <sdk>/usr/include` (zig's driver manages libc
 *            header search itself and would otherwise find no headers).
 *   Android  any host with an NDK — ANDROID_NDK_ROOT/ANDROID_NDK_HOME, or
 *            the newest ndk/<version> under ANDROID_HOME/ANDROID_SDK_ROOT
 *            or the platform-default SDK location; compiles add the NDK
 *            sysroot's generic and per-triple include directories.
 *
 * Library archives never link, so the sysroot's LIBRARIES are the
 * embedder's side of the contract: Xcode links iOS archives against the
 * selected SDK, and Gradle/NDK builds link Android archives against the
 * API-26+ bionic stubs. */
/** The Apple SDK root for one mobile platform, discovered through xcrun the
 * way Xcode's own build system selects it. Memoized per SDK name and
 * selection environment: production rediscovers per process, and the two
 * selection variables (DEVELOPER_DIR/SDKROOT) are already mutable-input
 * keys that disable persistent caching. */
const appleSdkMemos = new Map<string, string>();
function appleSdkRoot(sdk: "iphoneos" | "iphonesimulator", env: NodeJS.ProcessEnv): string {
  const key = [sdk, env["PATH"] ?? "", env["DEVELOPER_DIR"] ?? "", env["SDKROOT"] ?? ""].join("\0");
  const memo = appleSdkMemos.get(key);
  if (memo !== undefined) return memo;
  const probe = spawnSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], {
    encoding: "utf8",
    env,
  });
  const path = probe.status === 0 ? (probe.stdout ?? "").trim() : "";
  if (path === "" || !existsSync(join(path, "usr", "include"))) {
    throw new Error(
      `the ${sdk} SDK was not found (xcrun --sdk ${sdk} --show-sdk-path failed) — ` +
        `iOS targets need Xcode with the ${sdk === "iphoneos" ? "iPhoneOS" : "iPhoneSimulator"} SDK installed`,
    );
  }
  appleSdkMemos.set(key, path);
  return path;
}

/** Compare dotted-numeric NDK version directory names, newest first. */
function compareNdkVersionsDesc(a: string, b: string): number {
  const as = a.split(".").map((s) => Number.parseInt(s, 10));
  const bs = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const d = (bs[i] ?? 0) - (as[i] ?? 0);
    if (d !== 0 && Number.isFinite(d)) return d;
  }
  return a < b ? 1 : a > b ? -1 : 0;
}

/** The Android NDK sysroot for the selected environment: an explicit
 * ANDROID_NDK_ROOT/ANDROID_NDK_HOME wins; otherwise the newest ndk/<version>
 * under ANDROID_HOME, ANDROID_SDK_ROOT, or the platform-default SDK
 * location. The prebuilt host directory is discovered rather than guessed —
 * the NDK ships exactly one per host OS. Memoized per selection
 * environment. */
const ndkSysrootMemos = new Map<string, string>();
function androidNdkSysroot(env: NodeJS.ProcessEnv): string {
  const key = ["ANDROID_NDK_ROOT", "ANDROID_NDK_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT"]
    .map((name) => env[name] ?? "")
    .join("\0");
  const memo = ndkSysrootMemos.get(key);
  if (memo !== undefined) return memo;
  const ndkRoots: string[] = [];
  const explicit = [env["ANDROID_NDK_ROOT"], env["ANDROID_NDK_HOME"]].find(
    (root): root is string => root !== undefined && root !== "",
  );
  if (explicit !== undefined) {
    ndkRoots.push(explicit);
  } else {
    const sdkRoots = [
      env["ANDROID_HOME"],
      env["ANDROID_SDK_ROOT"],
      process.platform === "darwin"
        ? join(homedir(), "Library", "Android", "sdk")
        : process.platform === "win32"
          ? join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Android", "Sdk")
          : join(homedir(), "Android", "Sdk"),
    ].filter((root): root is string => root !== undefined && root !== "");
    for (const root of sdkRoots) {
      let versions: string[] = [];
      try {
        versions = readdirSync(join(root, "ndk")).filter((name) => /^\d/.test(name));
      } catch {
        continue;
      }
      versions.sort(compareNdkVersionsDesc);
      ndkRoots.push(...versions.map((version) => join(root, "ndk", version)));
    }
  }
  for (const ndk of ndkRoots) {
    const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt");
    let hosts: string[] = [];
    try {
      hosts = readdirSync(prebuilt).sort();
    } catch {
      continue;
    }
    for (const host of hosts) {
      const sysroot = join(prebuilt, host, "sysroot");
      if (existsSync(join(sysroot, "usr", "include", "aarch64-linux-android"))) {
        ndkSysrootMemos.set(key, sysroot);
        return sysroot;
      }
    }
  }
  throw new Error(
    "no Android NDK sysroot was found — install an NDK (sdkmanager 'ndk;<version>') and/or set " +
      "ANDROID_NDK_ROOT to it (ANDROID_HOME with an ndk/ directory also works). " +
      "aarch64-linux-android compiles against the NDK's bionic headers.",
  );
}

/** Resolve native platform flags independently of the machine running tests,
 * so the host-Linux contract remains pinned on every development host. */
function nativePlatformArgs(platform: NodeJS.Platform): Pick<CcDriver, "targetArgs" | "linkArgs"> {
  return platform === "linux"
    ? { targetArgs: ["-D_GNU_SOURCE"], linkArgs: ["-lm"] }
    : { targetArgs: [], linkArgs: [] };
}

export function resolveCc(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = process.platform,
): CcDriver {
  const cc = env["SCRIPTC_CC"] ?? "";
  const target = env["SCRIPTC_TARGET"] ?? "";
  const hostArgs = nativePlatformArgs(hostPlatform);
  if (cc === "" || cc === "clang") {
    if (target !== "") {
      throw new Error(
        `SCRIPTC_TARGET=${target} requires SCRIPTC_CC=zigcc — the default clang path has no cross-target sysroots.`,
      );
    }
    return { argv: ["clang"], target: null, zigTarget: null, ...hostArgs };
  }
  if (cc !== "zigcc") {
    throw new Error(`unknown SCRIPTC_CC '${cc}' (supported: clang, zigcc)`);
  }
  if (target === "") return { argv: ["zig", "cc"], target: null, zigTarget: null, ...hostArgs };
  // Validate the target spelling before any SDK/sysroot discovery. Source
  // emission uses the same pure classifier without resolving this driver.
  configuredTargetPlatform(env, hostPlatform);
  const mobileRefusal = mobileTargetRefusal(target, hostPlatform);
  if (mobileRefusal !== null) throw new Error(mobileRefusal);
  if (isIosTarget(target)) {
    // Library-mode-only target (compile()/compileC own the executable-lane
    // refusal). Zig bundles no Apple libc: the compile rides the selected
    // SDK sysroot, with the libc header directory spelled explicitly
    // because zig's driver manages libc search itself and consults no
    // -isysroot for it. The zig spelling pins the iOS 15.0 floor into
    // every object's LC_BUILD_VERSION minos.
    const simulator = target === "aarch64-apple-ios-simulator";
    const sdk = appleSdkRoot(simulator ? "iphonesimulator" : "iphoneos", env);
    const zigTarget = `aarch64-ios.${IPHONEOS_MIN_VERSION}${simulator ? "-simulator" : ""}`;
    return {
      argv: ["zig", "cc"],
      target,
      zigTarget,
      targetArgs: ["-target", zigTarget, "-isysroot", sdk, "-isystem", join(sdk, "usr", "include")],
      linkArgs: [],
    };
  }
  if (isAndroidTarget(target)) {
    // Library-mode-only target. Zig bundles no bionic: compiles ride the
    // NDK sysroot's generic and per-triple include directories. Bionic
    // supports _GNU_SOURCE like glibc (and hides some POSIX declarations
    // without it); the zig spelling pins the API 26 floor, which the NDK's
    // versioned stub libraries enforce at the embedder's link. API 26
    // bionic carries everything the library-lane units call (arc4random_buf
    // included), so no shim TU joins the archive.
    const sysroot = androidNdkSysroot(env);
    const zigTarget = `aarch64-linux-android.${ANDROID_MIN_API}`;
    return {
      argv: ["zig", "cc"],
      target,
      zigTarget,
      targetArgs: [
        "-target",
        zigTarget,
        "-D_GNU_SOURCE",
        // Android apps load native code as shared libraries, so the archive
        // has to be position-independent to link into one.
        "-fPIC",
        "-isystem",
        join(sysroot, "usr", "include"),
        "-isystem",
        join(sysroot, "usr", "include", "aarch64-linux-android"),
      ],
      linkArgs: ["-lm"],
    };
  }
  const linux = target.includes("linux");
  const wasi = target.includes("wasi");
  const musl = target.includes("linux-musl");
  return {
    argv: ["zig", "cc"],
    target,
    zigTarget: target,
    targetArgs: [
      "-target",
      target,
      ...(linux || wasi ? ["-D_GNU_SOURCE"] : []),
      ...(musl ? ["-DSCR_MUSL"] : []),
      ...(wasi ? ["-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_PROCESS_CLOCKS"] : []),
    ],
    linkArgs: linux
      ? ["-lm"]
      : wasi
        ? ["-lwasi-emulated-signal", "-lwasi-emulated-process-clocks"]
        : [],
  };
}

/** Musl intentionally has no predefined libc macro. The explicit Zig target
 * is therefore the source of truth for selecting its small runtime shim. */
export function isMuslTarget(driver: Pick<CcDriver, "target">): boolean {
  return driver.target?.includes("linux-musl") ?? false;
}

/** The OS the produced binary runs on: the triple's OS under SCRIPTC_TARGET,
 * the host's otherwise — so platform-conditional link flags follow the
 * TARGET, not the machine running the compiler. Exported for compile()/
 * analyze(): the FRONTEND consults it too (path.sep / os.EOL literals and
 * the path-module binding follow the target — a win32 triple compiles
 * Node-on-Windows semantics, path.win32 backing the bare module). */
export function targetPlatform(driver: CcDriver): string {
  if (driver.target === null) return process.platform;
  return configuredTargetPlatform({ SCRIPTC_TARGET: driver.target });
}

/** Architecture identity for host-native cache entries. Explicit cross targets
 * already name their complete target triple; native builds need the process
 * architecture too because one per-user cache can serve both native and
 * emulated processes (arm64 and Rosetta on macOS, for example). */
export function cacheTargetIdentity(
  driver: Pick<CcDriver, "target">,
  hostPlatform: NodeJS.Platform = process.platform,
  hostArch: string = process.arch,
): string {
  return driver.target === null ? `native:${hostPlatform}:${hostArch}` : `cross:${driver.target}`;
}
