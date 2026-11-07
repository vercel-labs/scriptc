/** `require.resolve(spec)` from `fromFile` for island code (scope-B NI-4).
 * The Node-hosted compiler installs Node's own resolver (index.ts,
 * createRequire), which keeps the process's settings and hooks; without one
 * (the self-hosted compiler) the shared filesystem resolver answers, as it
 * does for a compiled program's `require.resolve` (runtime-resolve.ts).
 * Throws when the specifier does not resolve. */
import { resolveCjsRuntime } from "../frontend/cjs-resolve.js";

type IslandResolver = (fromFile: string, spec: string) => string;

let islandResolver: IslandResolver | null = null;

export function setIslandResolver(resolver: IslandResolver): void {
  islandResolver = resolver;
}

export function resolveFrom(fromFile: string, spec: string): string {
  if (islandResolver !== null) return islandResolver(fromFile, spec);
  const resolved = resolveCjsRuntime(fromFile, spec);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return resolved.value;
}
