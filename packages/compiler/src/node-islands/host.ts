/* What an island build asks of the compiler that hosts it. The build steps
 * are the same code in the Node-hosted and in the self-hosted compiler; the
 * few answers that depend on where the compiler runs come from here. The
 * Node-hosted compiler installs Node's own (host-node.ts); the self-hosted
 * compiler installs what its toolchain manifest names (native/compiler.ts). */
import { resolveCjsRuntime } from "../frontend/cjs-resolve.js";

/** The static effect gate's verdict on a module (effect-gate.ts). */
export type IslandEffectGate = (
  path: string,
) => { ok: true } | { ok: false; reason: string; file: string };

export interface IslandBuildHost {
  /** `require.resolve(spec)` from `fromFile` for island code (scope-B NI-4);
   * throws when the specifier does not resolve. Node's own resolver keeps
   * the process's settings and hooks. Without one, the shared filesystem
   * resolver answers, as it does for a compiled program's `require.resolve`
   * (runtime-resolve.ts). */
  resolve?: (fromFile: string, spec: string) => string;
  /** The directory of package `name` installed as a dependency of the
   * compiler itself, or null. */
  compilerPackage: (name: string) => string | null;
  /** The directory of the runtime's C sources, from which the deferral probe
   * host is built (snapshot.ts), or null when the installation has none. */
  runtimeSources: () => string | null;
  /** The static effect gate, which words the deferral trace (the probe
   * decides). It parses with the TypeScript 5 JavaScript parser, so only
   * the Node-hosted compiler has it. */
  effectGate?: IslandEffectGate;
}

let host: IslandBuildHost = { compilerPackage: () => null, runtimeSources: () => null };

export function setIslandBuildHost(installed: IslandBuildHost): void {
  host = installed;
}

export function islandBuildHost(): IslandBuildHost {
  return host;
}

export function resolveFrom(fromFile: string, spec: string): string {
  const resolve = host.resolve;
  if (resolve !== undefined) return resolve(fromFile, spec);
  const resolved = resolveCjsRuntime(fromFile, spec);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.value;
}
