import { homedir } from "node:os";
import { resolve } from "node:path";

/** Resolve the build cache without touching the filesystem. Exported from this
 * internal module so its platform and override behavior can be pinned directly. */
export function resolveBuildCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string | null {
  if (env["SCRIPTC_NO_CACHE"] === "1") return null;
  const configured = env["SCRIPTC_CACHE_DIR"];
  if (configured !== undefined) return configured === "" ? null : resolve(configured);

  const xdg = env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg !== "") return resolve(xdg, "scriptc", "build");
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local !== undefined && local !== "") return resolve(local, "scriptc", "cache", "build");
  }
  return platform === "darwin"
    ? resolve(userHome, "Library", "Caches", "scriptc", "build")
    : resolve(userHome, ".cache", "scriptc", "build");
}

/** Resolve the compiler-level store without touching the filesystem. It holds
 * what a build derives from installed files alone, such as the runtime pack's
 * selection and the link driver's job, so every build on this machine shares
 * it. It follows the build cache's hard disable but not its location: a build
 * with an empty build cache still reads what an earlier build derived.
 * `SCRIPTC_STATE_DIR` overrides the location. */
export function resolveCompilerStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
): string | null {
  if (env["SCRIPTC_NO_CACHE"] === "1") return null;
  // An explicitly empty build cache asks for no persistent cache at all.
  if (env["SCRIPTC_CACHE_DIR"] === "") return null;
  const configured = env["SCRIPTC_STATE_DIR"];
  if (configured !== undefined) return configured === "" ? null : resolve(configured);

  const xdg = env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg !== "") return resolve(xdg, "scriptc", "compiler");
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    if (local !== undefined && local !== "") return resolve(local, "scriptc", "cache", "compiler");
  }
  return platform === "darwin"
    ? resolve(userHome, "Library", "Caches", "scriptc", "compiler")
    : resolve(userHome, ".cache", "scriptc", "compiler");
}
