/* Island modules the build writes (frontend/lowering/closed-island-init.ts):
 * the module-level constants of the program whose initializers only call
 * into Node islands, and its module-level statements that only do, moved
 * into the island so that the deferral of island modules (snapshot.ts)
 * applies to them.
 *
 * A generated module is a file of the shipped module tree (modules.ts) that
 * no file on the build machine holds: the tree's entry carries its text.
 * It sits in GENERATED_DIRECTORY under the tree root and names what it
 * imports by relative paths inside the tree, so only tree paths enter the
 * executable. Its text has one fixed form:
 *
 *   import <clause> from "<relative specifier>";     (zero or more)
 *   export const <name> = <expression>;              (a constant)
 *   <expression>;                                    (a statement)
 *
 * The build-time probe evaluates a copy outside the user's source tree
 * (probeCopy), whose imports name the build machine's files instead. */
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

/** Where generated modules sit in the tree, relative to its root. */
export const GENERATED_DIRECTORY = ".scriptc/closed";

export interface GeneratedImport {
  /** The import clause: `{ a, b as c }`, `name` or `* as name`. */
  clause: string;
  /** What it imports: an absolute real path of a tree file, or the key of
   * another generated module. */
  target: string;
}

export interface GeneratedModule {
  /** The program module the constant or statement comes from (a real
   * path). */
  source: string;
  /** Its position among the generated modules of `source`. */
  index: number;
  imports: GeneratedImport[];
  /** The `export const` statement of a constant, or the statement. */
  body: string;
}

/** The file name of a generated module: the source module's base name for
 * a reader, a digest of its path relative to the tree root (the same on
 * every machine that builds the tree) for uniqueness, and its index. */
export function generatedModuleName(sourceInTree: string, index: number): string {
  const stem = basename(sourceInTree).replace(/\.[cm]?[jt]sx?$/, "");
  const safe = stem.replace(/[^A-Za-z0-9_-]/g, "_");
  const digest = createHash("sha256").update(sourceInTree).digest("hex").slice(0, 10);
  return `${safe}.${digest}.${index}.mjs`;
}

/** The text of a generated module whose imports are `specifiers`, one per
 * import of `module`. */
export function generatedModuleText(module: GeneratedModule, specifiers: string[]): string {
  const lines = module.imports.map(
    (entry, i) => `import ${entry.clause} from ${JSON.stringify(specifiers[i]!)};\n`,
  );
  return `${lines.join("")}${module.body}`;
}

const IMPORT_LINE = /^import (.*) from ("(?:[^"\\]|\\.)*");$/;

/** The probe's copy of the generated module at `treeFile` (its place under
 * the tree root on the build machine): the same text with each import
 * naming an absolute path, the build machine's file for a tree file and
 * `copyOf`'s answer for another generated module. */
export function probeCopy(
  text: string,
  treeFile: string,
  copyOf: (treeFile: string) => string | undefined,
): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = IMPORT_LINE.exec(lines[i]!);
    if (match === null) break;
    const target = resolve(dirname(treeFile), JSON.parse(match[2]!) as string);
    lines[i] = `import ${match[1]!} from ${JSON.stringify(copyOf(target) ?? target)};`;
  }
  return lines.join("\n");
}

/** The tree path of the generated module named `name`. */
export function generatedTreePath(name: string): string {
  return `${GENERATED_DIRECTORY}/${name}`;
}

/** The place of a generated module under the tree root. */
export function generatedTreeFile(root: string, name: string): string {
  return join(root, ...GENERATED_DIRECTORY.split("/"), name);
}
