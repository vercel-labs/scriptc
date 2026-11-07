/* The Node-hosted compiler's answers for island builds (host.ts): Node's
 * own module resolution, from the calling file and from the compiler. */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { effectGate } from "./effect-gate.js";
import { setIslandBuildHost } from "./host.js";

const require = createRequire(import.meta.url);

function compilerPackage(name: string): string | null {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

export function installNodeIslandBuildHost(): void {
  setIslandBuildHost({
    resolve: (fromFile, spec) => createRequire(fromFile).resolve(spec),
    compilerPackage,
    runtimeSources: () => {
      const runtime = compilerPackage("@scriptc/runtime");
      return runtime === null ? null : join(runtime, "src");
    },
    effectGate,
  });
}
