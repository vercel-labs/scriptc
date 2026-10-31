/* Where a source file comes from. User code (the program's own tree and
 * workspace packages compiled from source) is strict; npm code (installed
 * packages under node_modules) is lenient and is decided per package
 * instance; shims are scriptc's own registry implementations; builtin
 * covers declaration files of the type world. */
import { join } from "node:path";
import { isPackageShimFile } from "../frontend/package-shims.js";
import { trackedReadFile } from "../frontend/input-tracker.js";

export type Origin = "user" | "npm" | "shim" | "builtin";

export function originOf(file: string): Origin {
  const path = file.split("\\").join("/");
  if (isPackageShimFile(path)) return "shim";
  if (/\.d\.[cm]?ts$/.test(path)) return "builtin";
  return path.includes("/node_modules/") ? "npm" : "user";
}

/** One installed package: the decision unit for npm code. pnpm keeps
 * versions apart in different directories, so the directory identifies the
 * instance. */
export interface PackageInstance {
  name: string;
  /** The package directory (…/node_modules/<name>). */
  dir: string;
  version: string | null;
}

/** The package instance of a file under node_modules: the LAST
 * node_modules segment (nested installs belong to the innermost package),
 * scope-aware. Null outside node_modules. */
export function packageDirOf(file: string): { name: string; dir: string } | null {
  const path = file.split("\\").join("/");
  const parts = path.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= parts.length - 1) return null;
  const first = parts[i + 1]!;
  if (first.startsWith("@")) {
    if (i + 2 >= parts.length - 1) return null;
    const name = `${first}/${parts[i + 2]!}`;
    return { name, dir: parts.slice(0, i + 3).join("/") };
  }
  return { name: first, dir: parts.slice(0, i + 2).join("/") };
}

/** The `version` field of a package directory's package.json. */
export function packageVersionOf(dir: string): string | null {
  let version: string | null = null;
  const text = trackedReadFile(join(dir, "package.json"));
  if (text !== null) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        const v = (parsed as Record<string, unknown>)["version"];
        if (typeof v === "string") version = v;
      }
    } catch {
      version = null;
    }
  }
  return version;
}

export function packageInstanceOf(file: string): PackageInstance | null {
  const at = packageDirOf(file);
  if (at === null) return null;
  return { name: at.name, dir: at.dir, version: packageVersionOf(at.dir) };
}
