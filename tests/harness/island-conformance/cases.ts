/* The programs the island conformance lane runs three ways
 * (island-conformance.test.ts), and the npm packages each one imports.
 *
 * Three sources:
 * - `npm/<case>`: every case of the npm suite (npm-cases.ts), with its argv
 *   lists;
 * - `corpus/<dir>`: corpus directory programs that carry their own
 *   node_modules and already compile without a Node island;
 * - `packages/<program>`: programs over widely used published packages,
 *   pinned in tests/fixtures/island-conformance.
 */
import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { npmCases } from "../npm-cases.js";

export interface ConformanceCase {
  /** `npm/<case>`, `corpus/<dir>` or `packages/<program>`: the key of the
   * program in known-failures.json. */
  name: string;
  entry: string;
  cwd: string;
  /** Every argv list runs each way. */
  argvs: string[][];
  /** Node's arguments before the entry. */
  nodeArgs: string[];
  /** Whether stderr is compared with Node's: an npm suite case opts in
   * (`// @stderr`), as it does in that suite; the others always compare. */
  compareStderr: boolean;
  /** The npm packages the program's own modules import, in source order. */
  packages: string[];
}

const repoRoot = join(import.meta.dirname, "../../..");
const fixturesRoot = join(repoRoot, "tests/fixtures");
const corpusDir = join(repoRoot, "tests/corpus");
const packagesRoot = join(fixturesRoot, "island-conformance");
const comptimeShim = pathToFileURL(join(import.meta.dirname, "../comptime-shim.mjs")).href;

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
const SOURCE_EXTS = ["ts", "mts", "cts", "js", "mjs", "cjs", "tsx", "jsx"];

/** The package a bare specifier names: its first segment, or the first two
 * of a scoped name. */
function packageOf(specifier: string): string | null {
  if (/^[./#]/.test(specifier) || specifier.includes(":") || isBuiltin(specifier)) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return name === "" ? null : name;
}

/** Whether a node_modules directory at or above `from` holds the package. */
function installed(name: string, from: string): boolean {
  for (let dir = from; dir.startsWith(repoRoot); dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    if (dir === repoRoot) break;
  }
  return false;
}

/** A relative specifier's source file, or null (a directory, JSON, or a
 * file the program names with an extension Node maps differently). */
function relativeSource(specifier: string, from: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTS.map((ext) => `${base}.${ext}`),
    // `./lib.js` written for a `lib.ts` source.
    ...SOURCE_EXTS.map((ext) => base.replace(/\.[cm]?js$/, `.${ext}`)),
  ];
  for (const file of candidates) {
    if (!SOURCE_EXTS.some((ext) => file.endsWith(`.${ext}`))) continue;
    if (file.includes("/node_modules/")) continue;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** The installed packages a program's own modules import: the entry and the
 * modules it reaches through relative specifiers. A syntax scan, so a
 * specifier in a comment or a string counts when the package is installed;
 * the build then reports a package the program does not load. */
export function importedPackages(entry: string): string[] {
  const packages: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[2]!;
      if (specifier.startsWith(".")) {
        const source = relativeSource(specifier, file);
        if (source !== null) queue.push(source);
        continue;
      }
      const name = packageOf(specifier);
      if (name === null || packages.includes(name)) continue;
      if (installed(name, dirname(file))) packages.push(name);
    }
  }
  return packages;
}

/** The two-line directive head of a corpus program. */
function directives(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n", 2)
    .filter((line) => line.startsWith("// @"));
}

/** Corpus directory programs with a node_modules of their own. A program
 * whose directive head asks for anything but an exit status is left to
 * differential.test.ts, which owns those oracles; `@requires-libnode`
 * programs already run their packages in an island. */
function corpusCases(): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  for (const modules of globSync(join(corpusDir, "*/node_modules")).sort()) {
    const dir = dirname(modules);
    const entry = ["ts", "js", "mjs", "cjs"]
      .map((ext) => join(dir, `main.${ext}`))
      .find((file) => existsSync(file));
    if (entry === undefined) continue;
    if (directives(entry).some((line) => !/^\/\/ @exit: \d+\s*$/.test(line))) continue;
    cases.push({
      name: `corpus/${dir.slice(corpusDir.length + 1)}`,
      entry,
      cwd: repoRoot,
      argvs: [[]],
      nodeArgs: ["--import", comptimeShim],
      compareStderr: true,
      packages: importedPackages(entry),
    });
  }
  return cases;
}

/** Command lines of the pinned package programs that take arguments. */
const PACKAGE_ARGVS: Record<string, string[][]> = {
  commander: [["ada", "--upper"], ["ada"], ["--help"], ["--version"], [], ["ada", "--nope"]],
  "process-argv": [["first", "--flag", "last"], []],
};

function packageCases(): ConformanceCase[] {
  return globSync(join(packagesRoot, "programs/*.ts"))
    .sort()
    .map((entry) => {
      const program = entry.slice(entry.lastIndexOf("/") + 1, -".ts".length);
      return {
        name: `packages/${program}`,
        entry,
        cwd: dirname(entry),
        argvs: PACKAGE_ARGVS[program] ?? [[]],
        nodeArgs: [],
        compareStderr: true,
        packages: importedPackages(entry),
      };
    });
}

export function conformanceCases(): ConformanceCase[] {
  return [
    ...npmCases(fixturesRoot).map((c) => ({
      name: `npm/${c.name}`,
      entry: c.entry,
      cwd: dirname(c.entry),
      argvs: c.argvs ?? [[]],
      nodeArgs: [],
      compareStderr: c.compareStderr === true,
      packages: importedPackages(c.entry),
    })),
    ...corpusCases(),
    ...packageCases(),
  ];
}
