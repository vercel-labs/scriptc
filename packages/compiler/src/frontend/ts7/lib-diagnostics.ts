/* The semantic diagnostics of the declaration files scriptc supplies (the
 * TypeScript libs and scriptc's own declaration files), reused across
 * builds. Checking them is most of the full check of a small program. When
 * no other file of a program can change what checking those files reports
 * (every one is a module without global or module augmentations, or a
 * script declaring no global name the supplied files declare), the answer
 * depends only on the checker, the compiler options that can change it (not
 * those of OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS) and the files themselves,
 * so a stored answer for the same three stands in for checking
 * them again: the server checks only the program's other files
 * (getDiagnosticsOfCheckedFiles), and the semantic diagnostics merge in the
 * order the full check sorts them, by file name. An answer is stored only
 * when the full check reports no global diagnostics: the global diagnostics
 * of checking the other files are then the full check's.
 *
 * The global names the supplied files declare matter only to programs with
 * scripts, and collecting them reads every supplied file's syntax tree,
 * which a program of modules does not otherwise read (about 4 MB at the
 * peak of a small build). An answer stored by such a program leaves them
 * out; the first program with scripts that uses the answer collects them
 * and stores them with it.
 *
 * A native distribution also ships prebuilt answers: the content keys of
 * the supplied file sets the checker reports no diagnostics in, recorded when
 * the distribution was built. A build whose store has no answer uses a
 * prebuilt one when the checker is the distribution's own and the files'
 * content key is among them, and stores it, so builds with an empty cache
 * skip the check of the supplied files too.
 *
 * The supplied set depends on the Node modules a program imports: each one
 * adds its fallback declarations. Those files declare ambient modules and
 * nothing global, and the TypeScript libs declare only globals and name no
 * module, so adding module files cannot change what checking the libs
 * reports. Nor can it change what checking scriptc's declaration files
 * reports when the set without module files reports nothing in them (every
 * name they use resolves among them and the libs) and no module file
 * declares a module they declare. A program whose set has no stored answer
 * therefore reuses the answers of the set without module files, stored or
 * prebuilt: for every file of that set when both hold, for the libs alone
 * otherwise. The server then checks the program's other files and the
 * supplied files not reused, and the answer for the whole set is stored. */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Node, SourceFile } from "./ast-types.js";
import type { Ts7DiagnosticData } from "./session-schema.generated.js";
import type { Ts7SessionProgram } from "./session.js";
import { NodeFlags, SyntaxKind } from "./enums.js";
import { walkPreorder } from "./ast.js";

/** Key-value storage for reused diagnostics (best effort: failures miss). */
export interface LibDiagnosticsStore {
  read(key: string): string | null;
  write(key: string, text: string): void;
}

/** The answers a distribution ships: the content keys (contentKey) of the
 * supplied file sets whose full check reported no diagnostics with the
 * checker release `checker`. */
export interface PrebuiltLibDiagnostics {
  checker: string;
  keys: ReadonlySet<string>;
}

/** A supplied file's part in reuse across sets: "library" for the
 * TypeScript libs, "module" for a Node module's fallback declarations, and
 * "declarations" for scriptc's other declaration files. */
export type SuppliedKind = "library" | "module" | "declarations";

const SCHEMA = "scriptc.lib-diagnostics.v2";
const PREBUILT_SCHEMA = "scriptc.lib-diagnostics-prebuilt.v1";

/**
 * Compiler options that cannot change what checking the supplied declaration
 * files reports, so their answers' keys leave them out: a project that sets
 * them shares the answers of one that does not, and a build with an empty
 * cache can use the prebuilt answers, which are recorded without a tsconfig.
 * - `noUnusedLocals` and `noUnusedParameters`: the checker reports no unused
 *   identifiers in declaration files.
 * - `noImplicitReturns`, `noFallthroughCasesInSwitch`, `allowUnusedLabels` and
 *   `allowUnreachableCode`: they apply to statements, which declaration files
 *   do not have.
 * - `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature`: they
 *   apply to element and property access expressions (and to destructuring
 *   and iteration), not to indexed access types.
 * - `allowSyntheticDefaultImports`: it applies to default imports, which the
 *   supplied files do not make.
 * lib-diagnostics-options.test.ts checks the supplied files with each of them
 * set and unset and compares the diagnostics, checks that the unused options
 * report nothing in a declaration file, and that the supplied files have none
 * of the statements, access expressions and default imports the others apply
 * to.
 */
export const OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS = [
  "noUnusedLocals",
  "noUnusedParameters",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "allowUnusedLabels",
  "allowUnreachableCode",
  "noUncheckedIndexedAccess",
  "noPropertyAccessFromIndexSignature",
  "allowSyntheticDefaultImports",
] as const;

const optionsWithoutSuppliedDiagnostics: ReadonlySet<string> = new Set(
  OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS,
);

/** `options` without OPTIONS_WITHOUT_SUPPLIED_DIAGNOSTICS, the others in their order. */
function suppliedFileOptions(options: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options))
    if (!optionsWithoutSuppliedDiagnostics.has(name)) kept[name] = value;
  return kept;
}

let configured: {
  store: LibDiagnosticsStore;
  checker: string;
  /** Read on the first store miss; null when there are none. */
  prebuilt: (() => PrebuiltLibDiagnostics | null) | null;
} | null = null;

/** Has later builds of this process reuse the diagnostics of the supplied
 * declaration files through `store`, for the checker identified by
 * `checker` (its executable's identity), or stop reusing them (null).
 * `prebuilt` reads the answers the distribution ships for that checker. */
export function setLibDiagnosticsStore(
  store: LibDiagnosticsStore | null,
  checker = "",
  prebuilt: (() => PrebuiltLibDiagnostics | null) | null = null,
): void {
  if (store === null) {
    configured = null;
    return;
  }
  let loaded: PrebuiltLibDiagnostics | null | undefined;
  configured = {
    store,
    checker,
    prebuilt:
      prebuilt === null ? null : () => (loaded === undefined ? (loaded = prebuilt()) : loaded),
  };
}

let prebuiltRecorder: { checker: string; record: (key: string) => void } | null = null;

/** Has later full checks that report no diagnostics in the supplied files
 * pass their content key (contentKey, for the checker release `checker`) to
 * `record`, or stop (null). A distribution build collects its prebuilt
 * answers this way. */
export function recordPrebuiltLibDiagnostics(
  recorder: { checker: string; record: (key: string) => void } | null,
): void {
  prebuiltRecorder = recorder;
}

/** Reads a prebuilt answers file (`{ schema, checker, keys }`); null when
 * it is missing or malformed. */
export function readPrebuiltLibDiagnostics(path: string): PrebuiltLibDiagnostics | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      schema?: unknown;
      checker?: unknown;
      keys?: unknown;
    };
    if (
      value.schema !== PREBUILT_SCHEMA ||
      typeof value.checker !== "string" ||
      !Array.isArray(value.keys) ||
      !value.keys.every((key) => typeof key === "string")
    )
      return null;
    return { checker: value.checker, keys: new Set(value.keys as string[]) };
  } catch {
    return null;
  }
}

/** A distribution's prebuilt answers at `path`, for its tsc-ts at `checker`
 * (`<package>/lib/tsc-ts`): null unless their checker release is the
 * version of the package the executable belongs to. */
export function distributionPrebuiltLibDiagnostics(
  path: string,
  checker: string,
): PrebuiltLibDiagnostics | null {
  const prebuilt = readPrebuiltLibDiagnostics(path);
  return prebuilt !== null && checkerPackageVersion(checker) === prebuilt.checker ? prebuilt : null;
}

/** The version of the tsc-ts package whose executable is `checker`
 * (`<package>/lib/tsc-ts`), or null when it cannot be read. */
export function checkerPackageVersion(checker: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(dirname(checker)), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The text of a prebuilt answers file holding `keys` for the checker
 * release `checker`. */
export function prebuiltLibDiagnosticsText(checker: string, keys: Iterable<string>): string {
  return `${JSON.stringify({ schema: PREBUILT_SCHEMA, checker, keys: [...new Set(keys)].sort() }, null, 1)}\n`;
}

/** A checker executable's identity for the stored diagnostics' key: its
 * path and file identity, or the path alone when it cannot be read. */
export function checkerExecutableIdentity(path: string): string {
  try {
    const info = statSync(path);
    return JSON.stringify([path, info.size, info.mtimeMs, info.ino]);
  } catch {
    return JSON.stringify([path]);
  }
}

/** The program's semantic and global diagnostics as the full check reports
 * them, using stored diagnostics for the supplied declaration files; null
 * when they cannot be reused for this program (then the caller asks for
 * them as before). `supplied` tells whether a program file is one of the
 * supplied declaration files, and `kind` which kind of supplied file it is
 * (by default scriptc's declarations, which reuse nothing across sets). */
export function reusedLibDiagnostics(
  program: Ts7SessionProgram,
  fileNames: readonly string[],
  supplied: (fileName: string) => boolean,
  sourceFile: (fileName: string) => SourceFile | undefined,
  kind: (fileName: string) => SuppliedKind = () => "declarations",
): { semantic: Ts7DiagnosticData[]; global: Ts7DiagnosticData[] } | null {
  return reuse(program, fileNames, supplied, sourceFile, () => true, false, kind);
}

/** reusedLibDiagnostics for a caller that keeps only the diagnostics of the
 * `kept` files: a stored answer then needs checking only the kept other
 * files, and without a stored answer the result is null (nothing is checked
 * or stored). */
export function reusedKeptLibDiagnostics(
  program: Ts7SessionProgram,
  fileNames: readonly string[],
  supplied: (fileName: string) => boolean,
  sourceFile: (fileName: string) => SourceFile | undefined,
  kept: ReadonlySet<string>,
): { semantic: Ts7DiagnosticData[]; global: Ts7DiagnosticData[] } | null {
  return reuse(
    program,
    fileNames,
    supplied,
    sourceFile,
    (name) => kept.has(name),
    true,
    () => "declarations",
  );
}

function reuse(
  program: Ts7SessionProgram,
  fileNames: readonly string[],
  supplied: (fileName: string) => boolean,
  sourceFile: (fileName: string) => SourceFile | undefined,
  keep: (fileName: string) => boolean,
  storedOnly: boolean,
  kind: (fileName: string) => SuppliedKind,
): { semantic: Ts7DiagnosticData[]; global: Ts7DiagnosticData[] } | null {
  if (configured === null || process.env["SCRIPTC_LIB_DIAGNOSTICS"] === "0") return null;
  const { store, checker } = configured;
  identities.clear();
  const libs: string[] = [];
  const own: string[] = [];
  for (const name of fileNames) (supplied(name) ? libs : own).push(name);
  if (libs.length === 0) return null;
  // The global names each of the program's scripts declares; a module that
  // declares nothing global contributes none.
  const scripts: Set<string>[] = [];
  for (const name of own) {
    const file = sourceFile(name);
    if (file === undefined) return null;
    if (file.externalModuleIndicator !== undefined) {
      if (!declaresNothingGlobal(file)) return null;
      continue;
    }
    const names = isJsFileName(name) ? null : scriptGlobalNames(file);
    if (names === null) return null;
    scripts.push(names);
  }
  // A script's globals cannot change what the supplied files report unless
  // one of them is also a global the supplied files declare.
  const collides = (globals: ReadonlySet<string>): boolean =>
    scripts.some((names) => [...names].some((name) => globals.has(name)));
  // The options without the configuration file's path, which names where the
  // project is and which checking the supplied files does not read (the files
  // a project's location brings in are part of the key), and without the
  // options that cannot change what checking them reports.
  const options = suppliedFileOptions({
    ...program.getCompilerOptions(),
    configFilePath: undefined,
  });
  const key = entryKey(checker, options, libs);
  if (key === null) return null;
  const stored = readEntry(store, key, libs) ?? prebuiltEntry(store, key, options, libs);
  // An answer stored without the supplied files' global names: a program
  // with scripts collects them and stores them with the answer.
  let globals = stored?.globals ?? null;
  if (stored !== null && globals === null && scripts.length > 0) {
    globals = suppliedGlobalNames(libs, sourceFile);
    if (globals !== null) writeEntry(store, key, globals, Object.fromEntries(stored.files));
  }
  if (stored !== null && (scripts.length === 0 || (globals !== null && !collides(globals)))) {
    const checkedNames = storedOnly ? own.filter(keep) : own;
    const checked = program.checkedFileDiagnosticData(checkedNames);
    if (checked === null) return null;
    const byFile = new Map<string, Ts7DiagnosticData[]>(
      storedOnly ? [...stored.files].filter(([name]) => keep(name)) : stored.files,
    );
    checkedNames.forEach((name, index) => byFile.set(name, checked.files[index] ?? []));
    return { semantic: inFileOrder(byFile), global: checked.global };
  }
  if (storedOnly) return null;
  // Another set's answers for the libs (see the header), for a program of
  // modules: its scripts' globals would need every supplied file's names.
  const kinds = new Map<string, SuppliedKind>();
  if (stored === null && scripts.length === 0) for (const name of libs) kinds.set(name, kind(name));
  const kindOf = (name: string): SuppliedKind => kinds.get(name) ?? "declarations";
  const libraries = libs.filter((name) => kindOf(name) === "library");
  const modules = libs.filter((name) => kindOf(name) === "module");
  const shared =
    modules.length > 0
      ? sharedAnswers(store, checker, options, libs, libraries, modules, sourceFile, kindOf)
      : null;
  if (shared !== null) {
    const checkedNames = [...own, ...libs.filter((name) => !shared.files.has(name))];
    const checked = program.checkedFileDiagnosticData(checkedNames);
    if (checked !== null) {
      const byFile = new Map(shared.files);
      checkedNames.forEach((name, index) => byFile.set(name, checked.files[index] ?? []));
      if (checked.global.length === 0) {
        const files: Record<string, Ts7DiagnosticData[]> = {};
        for (const name of libs) files[name] = byFile.get(name) ?? [];
        writeEntry(store, key, null, files);
      }
      return { semantic: inFileOrder(byFile), global: checked.global };
    }
  }
  // The full check, as before. Its answers for the supplied files are stored
  // when it reports no global diagnostics and the program's scripts declare
  // none of the supplied files' globals (so nothing of the program reached
  // what those files report).
  const global = program.diagnosticData("getGlobalDiagnostics");
  const semantic = program.diagnosticData("getSemanticDiagnostics");
  // A server that cannot check only some files could never use the answer.
  if (global.length === 0 && stored === null && program.checkedFileDiagnosticData([]) !== null) {
    const names = scripts.length === 0 ? null : suppliedGlobalNames(libs, sourceFile);
    if (scripts.length === 0 || (names !== null && !collides(names))) {
      const files: Record<string, Ts7DiagnosticData[]> = {};
      for (const name of libs) files[name] = program.diagnosticData("getSemanticDiagnostics", name);
      writeEntry(store, key, names, files);
      if (prebuiltRecorder !== null && Object.values(files).every((list) => list.length === 0)) {
        const content = contentKey(prebuiltRecorder.checker, options, libs);
        if (content !== null) prebuiltRecorder.record(content);
      }
    }
  }
  return { semantic, global };
}

/** Stores an answer: the supplied files' diagnostics, and their global names
 * when they were collected (null otherwise). Best effort: a failed write is
 * a later miss. */
function writeEntry(
  store: LibDiagnosticsStore,
  key: string,
  globals: ReadonlySet<string> | null,
  files: Record<string, Ts7DiagnosticData[]>,
): void {
  try {
    store.write(
      key,
      JSON.stringify({ schema: SCHEMA, globals: globals === null ? null : [...globals], files }),
    );
  } catch {
    // A failed write is a later miss.
  }
}

/** Whether a file cannot add to or change the global declarations the
 * supplied files declare: a module with no `declare global`, no module
 * augmentation and no UMD `export as namespace` declaration. */
function declaresNothingGlobal(file: SourceFile): boolean {
  if (file.externalModuleIndicator === undefined) return false;
  if (file.moduleAugmentations.length > 0) return false;
  for (const statement of file.statements.nodes) {
    if (statement.kind === SyntaxKind.NamespaceExportDeclaration) return false;
    // `declare global` (a module declaration named by the identifier `global`).
    if (
      statement.kind === SyntaxKind.ModuleDeclaration &&
      statement.name?.kind === SyntaxKind.Identifier &&
      statement.name.text === "global"
    )
      return false;
  }
  return true;
}

function isJsFileName(name: string): boolean {
  return /\.[cm]?jsx?$/.test(name);
}

/** The names a script file declares in the global scope: its top-level
 * declarations, and the `var` and function declarations of its top-level
 * blocks; null when it declares an ambient module (`declare module "x"`),
 * which can merge with one the supplied files declare. Over-approximates:
 * a name more only makes the stored answer apply less often. */
function scriptGlobalNames(file: SourceFile): Set<string> | null {
  const names = new Set<string>();
  let ambientModule = false;
  walkPreorder(file, (node) => {
    if (node === file) return undefined;
    if (node.kind === SyntaxKind.ModuleDeclaration && node.name?.kind === SyntaxKind.StringLiteral)
      ambientModule = true;
    const topLevel = node.parent === file;
    if (topLevel || node.kind === SyntaxKind.FunctionDeclaration) addDeclaredNames(node, names);
    else if (
      node.kind === SyntaxKind.VariableDeclarationList &&
      (node.flags & NodeFlags.BlockScoped) === 0
    )
      for (const declaration of node.declarations?.nodes ?? [])
        addBindingNames(declaration.name, names);
    // Functions, classes and namespaces have scopes of their own.
    return GLOBAL_SCOPE_BOUNDARIES.has(node.kind) ? "skip" : undefined;
  });
  return ambientModule ? null : names;
}

/** The global names the supplied files declare: the declarations of their
 * scripts (as scriptGlobalNames finds them, with ambient modules as their
 * quoted names) and those of the `declare global` blocks of their modules;
 * null when one of them is not available. */
function suppliedGlobalNames(
  libs: readonly string[],
  sourceFile: (fileName: string) => SourceFile | undefined,
): Set<string> | null {
  const names = new Set<string>();
  for (const name of libs) {
    const file = sourceFile(name);
    if (file === undefined) return null;
    if (file.externalModuleIndicator === undefined) {
      walkPreorder(file, (node) => {
        if (node === file) return undefined;
        if (
          node.kind === SyntaxKind.ModuleDeclaration &&
          node.name?.kind === SyntaxKind.StringLiteral
        )
          names.add(JSON.stringify(node.name.text ?? ""));
        if (node.parent === file || node.kind === SyntaxKind.FunctionDeclaration)
          addDeclaredNames(node, names);
        else if (
          node.kind === SyntaxKind.VariableDeclarationList &&
          (node.flags & NodeFlags.BlockScoped) === 0
        )
          for (const declaration of node.declarations?.nodes ?? [])
            addBindingNames(declaration.name, names);
        return GLOBAL_SCOPE_BOUNDARIES.has(node.kind) ? "skip" : undefined;
      });
      continue;
    }
    for (const statement of file.statements.nodes) {
      if (
        statement.kind !== SyntaxKind.ModuleDeclaration ||
        statement.name?.kind !== SyntaxKind.Identifier ||
        statement.name.text !== "global"
      )
        continue;
      for (const inner of statement.body?.statements?.nodes ?? []) addDeclaredNames(inner, names);
    }
  }
  return names;
}

const GLOBAL_SCOPE_BOUNDARIES = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.ModuleDeclaration,
]);

/** The names a statement declares in the scope it is in. */
function addDeclaredNames(node: Node, names: Set<string>): void {
  switch (node.kind) {
    case SyntaxKind.VariableStatement:
      for (const declaration of node.declarationList?.declarations?.nodes ?? [])
        addBindingNames(declaration.name, names);
      return;
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
      if (node.name?.kind === SyntaxKind.Identifier) names.add(node.name.text ?? "");
      return;
  }
}

function addBindingNames(name: Node | undefined, names: Set<string>): void {
  if (name === undefined) return;
  if (name.kind === SyntaxKind.Identifier) {
    names.add(name.text ?? "");
    return;
  }
  // Object and array binding patterns.
  for (const element of name.elements?.nodes ?? []) addBindingNames(element.name, names);
}

/** The stored diagnostics' key: the checker, the compiler options and the
 * supplied files in program order with each one's file identity; null when
 * one of them cannot be read. */
function entryKey(checker: string, options: unknown, libs: readonly string[]): string | null {
  const files: unknown[] = [];
  for (const name of libs) {
    try {
      files.push(fileIdentity(name));
    } catch {
      return null;
    }
  }
  return createHash("sha256")
    .update(JSON.stringify({ schema: SCHEMA, checker, options, files }))
    .digest("hex");
}

/** The files' identities (path, size, modification time, inode), kept for
 * one reuse: the keys of a set and of the set without its module files
 * share most of their files. */
const identities = new Map<string, [string, number, number, number]>();

function fileIdentity(name: string): [string, number, number, number] {
  let identity = identities.get(name);
  if (identity === undefined) {
    const info = statSync(name);
    identity = [name, info.size, info.mtimeMs, info.ino];
    identities.set(name, identity);
  }
  return identity;
}

/** Answers of the set without module files (see the header), stored or
 * prebuilt, when the program's module files declare nothing global: for
 * every file of that set when its answer reports no diagnostics and the
 * module files declare no module its declaration files declare, otherwise
 * for the libs alone; null when there is none. */
function sharedAnswers(
  store: LibDiagnosticsStore,
  checker: string,
  options: unknown,
  libs: readonly string[],
  libraries: readonly string[],
  modules: readonly string[],
  sourceFile: (fileName: string) => SourceFile | undefined,
  kind: (fileName: string) => SuppliedKind,
): { files: Map<string, Ts7DiagnosticData[]> } | null {
  if (libraries.length === 0) return null;
  const base = libs.filter((name) => kind(name) !== "module");
  const key = entryKey(checker, options, base);
  const entry = key === null ? null : readEntry(store, key, base);
  const prebuilt = configured?.prebuilt?.() ?? null;
  const prebuiltClean = (): boolean => {
    if (prebuilt === null || prebuilt.keys.size === 0) return false;
    const content = contentKey(prebuilt.checker, options, base);
    return content !== null && prebuilt.keys.has(content);
  };
  const clean =
    entry !== null ? [...entry.files.values()].every((list) => list.length === 0) : prebuiltClean();
  if (clean) {
    const declared = moduleNames(modules, sourceFile);
    if (declared === null) return null;
    const own = declaredModuleNames(base.filter((name) => kind(name) === "declarations"));
    const reused = own !== null && ![...declared].some((name) => own.has(name)) ? base : libraries;
    const files = new Map<string, Ts7DiagnosticData[]>();
    for (const name of reused) files.set(name, []);
    return { files };
  }
  if (entry === null || moduleNames(modules, sourceFile) === null) return null;
  return {
    files: new Map(
      libraries.map((name): [string, Ts7DiagnosticData[]] => [name, entry.files.get(name)!]),
    ),
  };
}

/** The ambient modules the module files declare, when each one declares
 * only ambient modules (`declare module "x"`) with no `global` augmentation,
 * or is a module that declares nothing global: then it adds nothing the libs
 * can see. Null otherwise. */
function moduleNames(
  modules: readonly string[],
  sourceFile: (fileName: string) => SourceFile | undefined,
): Set<string> | null {
  const names = new Set<string>();
  for (const name of modules) {
    const file = sourceFile(name);
    if (file === undefined) return null;
    if (file.externalModuleIndicator !== undefined) {
      if (!declaresNothingGlobal(file)) return null;
      continue;
    }
    for (const statement of file.statements.nodes) {
      if (
        statement.kind !== SyntaxKind.ModuleDeclaration ||
        statement.name?.kind !== SyntaxKind.StringLiteral
      )
        return null;
      names.add(statement.name.text ?? "");
      for (const inner of statement.body?.statements?.nodes ?? [])
        if (
          inner.kind === SyntaxKind.ModuleDeclaration &&
          inner.name?.kind === SyntaxKind.Identifier &&
          inner.name.text === "global"
        )
          return null;
    }
  }
  return names;
}

/** The module names scriptc's declaration files name in a module
 * declaration (`module "x"` or `module 'x'`, in their text, so also in
 * comments); null when one of them cannot be read or names a pattern
 * (`"*"`), which a module file's module could also match. */
function declaredModuleNames(files: readonly string[]): Set<string> | null {
  const names = new Set<string>();
  for (const name of files) {
    let text: string;
    try {
      text = readFileSync(name, "utf8");
    } catch {
      return null;
    }
    for (const match of text.matchAll(/\bmodule\s+(["'])(.*?)\1/g)) {
      if (match[2]!.includes("*")) return null;
      names.add(match[2]!);
    }
  }
  return names;
}

/** The supplied files' answer from the distribution's prebuilt answers,
 * stored under `key` for later builds: every file without diagnostics, when
 * they hold the files' content key; null otherwise. */
function prebuiltEntry(
  store: LibDiagnosticsStore,
  key: string,
  options: unknown,
  libs: readonly string[],
): { files: Map<string, Ts7DiagnosticData[]>; globals: Set<string> | null } | null {
  const prebuilt = configured?.prebuilt?.() ?? null;
  if (prebuilt === null || prebuilt.keys.size === 0) return null;
  const content = contentKey(prebuilt.checker, options, libs);
  if (content === null || !prebuilt.keys.has(content)) return null;
  const files: Record<string, Ts7DiagnosticData[]> = {};
  for (const name of libs) files[name] = [];
  writeEntry(store, key, null, files);
  return { files: new Map(Object.entries(files)), globals: null };
}

/** A supplied file set's key independent of where the files are installed:
 * the checker release, the compiler options and each file's name and
 * content digest, in program order; null when a file cannot be read. */
function contentKey(checker: string, options: unknown, libs: readonly string[]): string | null {
  const files: [string, string][] = [];
  for (const name of libs) {
    try {
      files.push([basename(name), contentDigest(name)]);
    } catch {
      return null;
    }
  }
  return createHash("sha256")
    .update(JSON.stringify({ schema: PREBUILT_SCHEMA, checker, options, files }))
    .digest("hex");
}

/** The digests of files' contents by path and file identity: a build that
 * misses its answer computes the content keys of its set and of the set
 * without module files, which share most of their files. */
const contentDigests = new Map<string, string>();

function contentDigest(name: string): string {
  const identity = JSON.stringify(fileIdentity(name));
  let digest = contentDigests.get(identity);
  if (digest === undefined) {
    digest = createHash("sha256").update(readFileSync(name)).digest("hex");
    contentDigests.set(identity, digest);
  }
  return digest;
}

function readEntry(
  store: LibDiagnosticsStore,
  key: string,
  libs: readonly string[],
): { files: Map<string, Ts7DiagnosticData[]>; globals: Set<string> | null } | null {
  let text: string | null;
  try {
    text = store.read(key);
  } catch {
    return null;
  }
  if (text === null) return null;
  let entry: { schema?: unknown; globals?: unknown; files?: Record<string, Ts7DiagnosticData[]> };
  try {
    entry = JSON.parse(text) as typeof entry;
  } catch {
    return null;
  }
  if (
    entry.schema !== SCHEMA ||
    entry.files === undefined ||
    (entry.globals !== null && !Array.isArray(entry.globals))
  )
    return null;
  const files = new Map<string, Ts7DiagnosticData[]>();
  for (const name of libs) {
    const list = entry.files[name];
    if (!Array.isArray(list)) return null;
    files.set(name, list);
  }
  const globals = Array.isArray(entry.globals)
    ? new Set(entry.globals.filter((name): name is string => typeof name === "string"))
    : null;
  return { files, globals };
}

/** Each file's diagnostics (already in the checker's order) in the order the
 * checker sorts files: by file name, compared by code point. */
export function inFileOrder(byFile: ReadonlyMap<string, Ts7DiagnosticData[]>): Ts7DiagnosticData[] {
  const names = [...byFile.keys()].sort(compareCodePoints);
  const out: Ts7DiagnosticData[] = [];
  for (const name of names) for (const d of byFile.get(name)!) out.push(d);
  return out;
}

function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
