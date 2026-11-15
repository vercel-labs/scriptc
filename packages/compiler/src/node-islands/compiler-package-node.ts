/* Where a package installed as a dependency of the Node-hosted compiler is,
 * by Node's own resolution from the compiler. The island build host answers
 * with it (host-node.ts); CLI startup, which looks for an installed libnode
 * pack before the host is installed and must not load the host's static
 * effect gate, names it directly (startup-cache.ts). */
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

export function nodeCompilerPackage(name: string): string | null {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}
