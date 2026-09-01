import { hostSupportsRuntimePack } from "../scripts/runtime-pack-host.mjs";

export const LEGACY_C_EXECUTABLE_WARNING =
  "scriptc: warning: SCRIPTC_CC selects the deprecated legacy C executable path on macOS arm64; " +
  "unset it to use the bundled LLVM helper/runtime pack, or use SCRIPTC_LINKER to select the platform linker driver\n";

export function shouldWarnLegacyCExecutable(options: {
  executable: boolean;
  fromC: boolean;
  backend: "c" | "llvm" | undefined;
  sanitize: boolean;
}, env: NodeJS.ProcessEnv = process.env, runtimePackHost = hostSupportsRuntimePack()): boolean {
  return options.executable && !options.fromC &&
    options.backend !== "c" && !options.sanitize &&
    (env["SCRIPTC_TARGET"] ?? "") === "" &&
    runtimePackHost &&
    env["SCRIPTC_CC"] !== undefined && env["SCRIPTC_CC"] !== "";
}
