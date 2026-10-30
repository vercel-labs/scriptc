/* Worker entries of a module whose shipped copy Node runs (scope-B: an
 * island module, or a module such an island loads). Node starts a worker
 * thread with its own module instances: the thread re-evaluates the entry
 * and everything the entry imports. So the module tree ships the entry and
 * its static import subtree as real sources (node-islands/modules.ts), and
 * the Worker keeps its path: the URL the module builds from its own URL at
 * build time names the same file in the tree.
 *
 * Only a form the tree can keep is accepted: an entry relative to the
 * module's own URL (`new URL("./entry.ts", import.meta.url)`, through
 * consts, templates and fileURLToPath; `import.meta.url` itself;
 * `__filename`). Every other form a build can see is refused, because the
 * tree keeps relative layout and nothing else:
 *  - a computed or unbounded entry: the build cannot know what to ship;
 *  - an absolute path or a `file:` URL that is not built from the module's
 *    own URL: the tree never holds a build-machine path;
 *  - a path relative to the process's working directory (Node resolves a
 *    plain relative filename against `cwd`): the tree is not the cwd.
 * A static entry that names no file at all (a data: URL, a package
 * specifier, a missing path) is Node's own business and stays as it is.
 *
 * A TypeScript file that ships this way must pass stripProblem: Node
 * erases types in place in a worker thread too, and it refuses to do so
 * inside node_modules.
 *
 * The scan reads only the program's own sources, and never the TypeScript
 * parser: a worker entry is a program root and its import graph is in the
 * program (worker-target.ts), so the files this ships are exactly the ones
 * the checker bound. A module of the tree the program does not hold has no
 * checked source, and its Worker stays Node's own business, as it was before
 * the tree carried it. The compiler itself is compiled natively, where the
 * parser island's rpc-api/rpc-process modules cannot lower — importing them
 * from a lowering-side module breaks the self-hosted build. */
import { resolve } from "node:path";
import { trackedFileExists } from "./input-tracker.js";
import * as ts from "./ts7/adapter.js";
import { tsgoPath } from "./dts-paths.js";
import { fromModuleUrl, staticForkString } from "./fork-target.js";
import { moduleSourceCandidates } from "./module-source-candidates.js";
import { isWorkerConstructor, workerModulePath } from "./worker-target.js";
import type { NodeIslandWorkerScan } from "../node-islands/modules.js";
import { stripProblem } from "../node-islands/type-strip.js";

export interface IslandWorkerScan {
  /** The worker entries `file`'s shipped copy starts, or the reason one
   * cannot ship (node-islands/modules.ts asks for each traced module).
   * `fresh`: the file belongs to a worker entry's subtree, so its shipped
   * copy runs in the worker thread even when the program compiles it. */
  workers(file: string, fresh: boolean): NodeIslandWorkerScan;
  /** Why Node cannot run `file`'s source as shipped, or null. */
  sourceProblem(file: string): string | null;
}

const TYPESCRIPT = /\.[mc]?ts$/;

const NONE: NodeIslandWorkerScan = { kind: "entries", files: [] };

/** The scan over one program: `compiled` answers whether the program lowers
 * a file natively, whose Worker constructions the native lowering answers
 * (lowerWorkerNew), so outside a worker entry's subtree they never run from
 * the shipped tree. Inside one (`fresh`), the worker thread evaluates the
 * file's shipped copy, natively compiled or not, and its Worker
 * constructions are scanned. `compiled` is asked on every call, not read
 * once: the module order grows while lowering (worker targets join it) and
 * the tree is collected after. */
export function createIslandWorkerScan(
  program: ts.Program,
  compiled: (file: string) => boolean,
): IslandWorkerScan {
  let programSources: Map<string, ts.SourceFile> | null = null;
  const key = (file: string): string => tsgoPath(resolve(file));
  const sourceOf = (file: string): ts.SourceFile | null => {
    programSources ??= new Map();
    if (programSources.size === 0)
      for (const sf of program.getImplementationSourceFiles())
        programSources.set(key(sf.fileName), sf);
    return programSources.get(key(file)) ?? null;
  };

  const workers = (file: string, fresh: boolean): NodeIslandWorkerScan => {
    if (!fresh && compiled(key(file))) return NONE;
    // A file outside the program has no checked source: its Worker cannot be
    // recognised, and Node reports its entry as a missing module in the
    // worker thread exactly as it did before the tree carried the file.
    const sf = sourceOf(file);
    if (sf === null) return NONE;
    const entries = new Set<string>();
    for (const construction of moduleSourceCandidates(program, sf).constructions) {
      const args = construction.arguments?.nodes ?? [];
      // An arity the constructor rejects is the runtime's error, in the
      // island exactly as under Node.
      if (args.length === 0 || args.length > 2 || args.some(ts.isSpreadElement)) continue;
      if (!isWorkerConstructor(program, construction.expression)) continue;
      const entry = args[0]!;
      const path = workerModulePath(program, entry);
      if (path === null) {
        // A static entry that names no file of the build (a data: URL a
        // package specifier, a filename relative to the working directory)
        // is Node's to resolve; only an entry the build cannot even see is
        // refused.
        if (staticForkString(program, entry) !== null) continue;
        return { kind: "refused", reason: refusal(sf, construction, "cannot resolve") };
      }
      if (!fromModuleUrl(program, entry))
        return {
          kind: "refused",
          reason: refusal(sf, construction, `names the build-machine path '${path}'`),
        };
      // A file that does not exist is loaded (and fails) exactly as under
      // Node: there is nothing for the tree to carry.
      if (trackedFileExists(path)) entries.add(path);
    }
    return entries.size === 0 ? NONE : { kind: "entries", files: [...entries].sort() };
  };

  const sourceProblem = (file: string): string | null => {
    if (!TYPESCRIPT.test(file)) return null;
    if (/[\\/]node_modules[\\/]/.test(file))
      return `'${file}' runs in a worker thread of a Node island, but Node refuses to strip types inside node_modules`;
    const sf = sourceOf(file);
    if (sf === null) return null;
    const problem = stripProblem(program, sf);
    if (problem === null) return null;
    return `'${file}' runs in a worker thread of a Node island, but Node cannot strip its types: ${problem.construct}`;
  };

  return { workers, sourceProblem };
}

/** A one-line description of the construction, anchored at its source: the
 * collector's diagnostics carry the reason as a message. */
function refusal(sf: ts.SourceFile, node: ts.Node, what: string): string {
  const line = sf.text.slice(0, ts.tokenStartOfNode(node)).split("\n").length;
  return `${sf.fileName}:${line} starts a Worker whose entry the build ${what}; a worker entry that runs in a Node island is new URL("./entry.ts", import.meta.url), so the build ships the entry and the modules it imports beside the module`;
}
