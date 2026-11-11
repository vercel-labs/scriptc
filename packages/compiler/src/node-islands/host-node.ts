/* The Node-hosted compiler's answers for island builds (host.ts): Node's
 * own module resolution, from the calling file and from the compiler. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { nodeCompilerPackage } from "./compiler-package-node.js";
import { effectGate } from "./effect-gate.js";
import { setIslandBuildHost } from "./host.js";

export function installNodeIslandBuildHost(): void {
  setIslandBuildHost({
    resolve: (fromFile, spec) => createRequire(fromFile).resolve(spec),
    compilerPackage: nodeCompilerPackage,
    runtimeSources: () => {
      const runtime = nodeCompilerPackage("@scriptc/runtime");
      return runtime === null ? null : join(runtime, "src");
    },
    effectGate,
  });
}
