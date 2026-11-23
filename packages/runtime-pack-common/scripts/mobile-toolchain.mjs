import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** SDKs are packaging inputs. Library consumers only need the resulting objects. */
export function mobileRuntimeConfig(name, env = process.env, platform = process.platform) {
  const common = {
    libraryOnly: true,
    runtimeDefines: ["_GNU_SOURCE"],
    threadArgs: ["-pthread"],
    compileFlags: ["-ffunction-sections", "-fdata-sections"],
    systemLibraries: [{ name: "m", predicate: true }],
  };
  if (name === "ios-arm64" || name === "ios-simulator-arm64") {
    if (platform !== "darwin")
      throw new Error("iOS runtime packs must be built with Xcode on macOS");
    const simulator = name === "ios-simulator-arm64";
    const sdk = simulator ? "iphonesimulator" : "iphoneos";
    const triple = `arm64-apple-ios15.0.0${simulator ? "-simulator" : ""}`;
    const sysroot = execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], {
      encoding: "utf8",
      env,
    }).trim();
    return {
      ...common,
      platform: "darwin",
      compiler: "clang",
      archiver: "ar",
      compileFlags: [],
      target: {
        name,
        llvm_triple: triple,
        architecture: "arm64",
        object_format: "macho",
        minimum_os: "15.0",
      },
      targetArgs: ["-target", triple, "-isysroot", sysroot],
      systemLibraries: [{ name: "System", predicate: true }],
    };
  }
  if (name !== "android-arm64") throw new Error(`unsupported mobile runtime pack: ${name}`);
  const ndk = env.ANDROID_NDK_ROOT ?? env.ANDROID_NDK_HOME;
  if (!ndk)
    throw new Error(
      "set ANDROID_NDK_ROOT to Android NDK 27 or newer to build the Android runtime pack",
    );
  const host =
    platform === "darwin"
      ? "darwin-x86_64"
      : platform === "win32"
        ? "windows-x86_64"
        : "linux-x86_64";
  const toolchain = join(ndk, "toolchains", "llvm", "prebuilt", host);
  const compiler = join(toolchain, "bin", platform === "win32" ? "clang.exe" : "clang");
  if (!existsSync(compiler)) throw new Error(`Android NDK compiler is missing: ${compiler}`);
  return {
    ...common,
    platform: "linux",
    compiler,
    archiver: join(toolchain, "bin", platform === "win32" ? "llvm-ar.exe" : "llvm-ar"),
    target: {
      name,
      llvm_triple: "aarch64-unknown-linux-android26",
      architecture: "arm64",
      object_format: "elf",
      minimum_os: "Android 26",
    },
    targetArgs: ["--target=aarch64-linux-android26", "--sysroot", join(toolchain, "sysroot")],
    // Android apps load native code as shared libraries; the pack's objects link into one.
    compilerFlags: ["-fPIC"],
  };
}
