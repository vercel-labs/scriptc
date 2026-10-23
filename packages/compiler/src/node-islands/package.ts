/* Packaging of island code (DESIGN.md §2.13, scope-B NI-4). A program
 * loads its island modules by path. Built in place, the paths are the
 * installed files. With `beside` packaging (`--libnode=beside`, which
 * already places the libnode pack next to the executable), the island
 * packages and the packages they load are copied to
 * `<output>.node-islands/node_modules/`, laid out so Node's resolver finds
 * the same files, and the program records `$ORIGIN/`-relative paths. The
 * `embedded` packaging of the design (a compressed section extracted on
 * first use) is not implemented yet. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { IrModule } from "../ir/ir.js";
import { ORIGIN } from "./libnode.js";
import { packageDirOf } from "./origin.js";

const LOAD_FNS = new Set(["nodeIsland.require", "nodeIsland.defer", "nodeIsland.import"]);

/** Every island module path the IR loads (the string literal argument of
 * each nodeIsland.require / nodeIsland.import). */
function islandLoads(mod: IrModule): { node: { value: string } }[] {
  const found: { node: { value: string } }[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (o["kind"] === "libCall" && typeof o["fn"] === "string" && LOAD_FNS.has(o["fn"])) {
      const arg = (o["args"] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
      if (arg !== undefined && arg["kind"] === "strLit" && typeof arg["value"] === "string")
        found.push({ node: arg as { value: string } });
    }
    for (const k in o) if (k !== "loc" && k !== "type") walk(o[k]);
  };
  walk(mod.functions);
  walk(mod.globals);
  return found;
}

/** The package directory `dep` resolves to from `fromDir`, walking up the
 * node_modules chain as Node does. */
function dependencyDir(fromDir: string, dep: string): string | null {
  for (let dir = fromDir; ;) {
    const candidate = join(dir, "node_modules", dep);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function dependenciesOf(dir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
  } catch {
    return [];
  }
}

/** Copies the island packages (and their dependency closure) next to the
 * executable and rewrites the module's island load paths to
 * `$ORIGIN/<output>.node-islands/node_modules/...`. A no-op without
 * island loads. */
export function placeIslandsBeside(mod: IrModule, outPath: string): void {
  const loads = islandLoads(mod);
  if (loads.length === 0) return;
  const rootName = `${basename(outPath)}.node-islands`;
  const root = join(dirname(outPath), rootName, "node_modules");
  rmSync(join(dirname(outPath), rootName), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const copied = new Map<string, string>();
  const place = (name: string, dir: string): void => {
    if (copied.has(dir)) return;
    const target = join(root, name);
    if ([...copied.values()].includes(target)) return; // a second version: first wins
    copied.set(dir, target);
    cpSync(dir, target, {
      recursive: true,
      dereference: true,
      filter: (src) => !relative(dir, src).split("/").includes("node_modules"),
    });
    for (const dep of dependenciesOf(dir)) {
      const depDir = dependencyDir(dir, dep);
      if (depDir !== null) place(dep, depDir);
    }
  };
  for (const load of loads) {
    const at = packageDirOf(load.node.value);
    if (at === null) continue;
    place(at.name, at.dir);
    const target = copied.get(at.dir);
    if (target === undefined) continue;
    const rel = relative(dirname(outPath), join(target, relative(at.dir, load.node.value)));
    load.node.value = `${ORIGIN}${rel}`;
  }
}
