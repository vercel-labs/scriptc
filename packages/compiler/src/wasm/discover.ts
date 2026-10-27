/* Build-time discovery of the WebAssembly modules a program can load.
 *
 * `scriptc coverage` reports every module whose bytes the build can see,
 * from four sources:
 *
 * 1. path: a `.wasm` path the compiler resolves from the source text
 *    (`require.resolve`, `createRequire(...).resolve`, `import.meta.resolve`,
 *    `new URL("./x.wasm", import.meta.url)`, and `path.join(__dirname, ...)`
 *    or `__dirname + "/x.wasm"`), or a `.so` path spelled the same ways
 *    whose file is a module (WebAssembly shared libraries, such as
 *    quickjs-wasi's extensions);
 * 2. inline: a string literal that decodes as base64 to a module, or an
 *    array literal of its bytes;
 * 3. package: every `.wasm` file shipped by a reached npm package whose
 *    program files mention `WebAssembly` (this finds paths computed at run
 *    time, such as a loader's default argument);
 * 4. config: the `scriptc.wasm` list in the entry's package.json and the
 *    `--wasm <file>` flag.
 *
 * Each module is decoded and validated (binary.ts) and reported once, by
 * content, with every source that found it. Nothing here changes what a
 * build emits. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as ts from "../frontend/ts7/adapter.js";
import { trackedAccessibleEntries, trackedReadFile } from "../frontend/input-tracker.js";
import { readProjectConfig } from "../project-config.js";
import { analyzeWasm, isWasmHeader, type WasmModuleSummary } from "./binary.js";
import { decodeBase64 } from "./base64.js";

export { decodeBase64 };

export type WasmSourceKind = "path" | "inline" | "package" | "config";

export interface WasmSource {
  kind: WasmSourceKind;
  /** The source file (path, inline) or the file that names the module. */
  file: string;
  /** 1-based line of the site, when there is one. */
  line?: number;
}

/** One discovered module. JSON-shaped: the coverage verdict cache stores it. */
export interface WasmModuleReport extends WasmModuleSummary {
  sha256: string;
  /** The module file, absent for inline modules. */
  path?: string;
  sources: WasmSource[];
}

export interface WasmDiscoveryInput {
  /** The program's source files (entry and modules). */
  files: readonly ts.SourceFile[];
  /** The entry file. */
  entry: string;
  /** --wasm files, absolute. */
  configured: readonly string[];
  /** require.resolve from `fromFile`, or null when it does not resolve. */
  resolveRequest: (fromFile: string, specifier: string) => string | null;
  /** Receives each distinct module's bytes once, when it is first found
   * (builds translate them). */
  onModule?: (sha256: string, bytes: Uint8Array) => void;
}

const SCAN_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
]);

/** The base64 spelling of a module's first bytes ("\0asm"). */
const BASE64_MAGIC = "AGFzbQ";
const BYTES_MAGIC = /\[\s*(?:0|0x0+)\s*,\s*(?:97|0x61)\s*,\s*(?:115|0x73)\s*,\s*(?:109|0x6d)\s*,/i;
/** Package directories deeper than this are not searched for modules. */
const PACKAGE_SCAN_DEPTH = 6;
/** A `.so` path in a string literal: the cheap test before a file with no
 * `.wasm` mention is walked for shared-library paths. */
const SHARED_LIBRARY_PATH = /\.so["'`]/;
/** Larger files are reported by size but not read. */
const MAX_MODULE_BYTES = 256 * 1024 * 1024;

class Discovery {
  input: WasmDiscoveryInput;
  byHash = new Map<string, WasmModuleReport>();
  byPath = new Map<string, string>();
  order: string[] = [];

  constructor(input: WasmDiscoveryInput) {
    this.input = input;
  }

  /** Records a module and one source that found it; answers its hash. */
  addBytes(bytes: Uint8Array, path: string | undefined, source: WasmSource): string {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let report = this.byHash.get(sha256);
    if (report === undefined) {
      const summary = analyzeWasm(bytes);
      report = {
        size: summary.size,
        status: summary.status,
        error: summary.error,
        features: summary.features,
        unsupported: summary.unsupported,
        functions: summary.functions,
        imports: summary.imports,
        exports: summary.exports,
        importModules: summary.importModules,
        memories: summary.memories,
        tables: summary.tables,
        globals: summary.globals,
        customSections: summary.customSections,
        sha256,
        sources: [],
      };
      this.byHash.set(sha256, report);
      this.order.push(sha256);
      this.input.onModule?.(sha256, bytes);
    }
    if (report.path === undefined && path !== undefined) report.path = path;
    addSource(report, source);
    return sha256;
  }

  addFile(path: string, source: WasmSource): void {
    path = resolve(path);
    const known = this.byPath.get(path);
    if (known !== undefined) {
      addSource(this.byHash.get(known)!, source);
      return;
    }
    // The tracked read makes the coverage verdict cache depend on the file.
    if (trackedReadFile(path) === null) return;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      return;
    }
    if (bytes.length > MAX_MODULE_BYTES) return;
    // A shared-library path names a module only when the file is one.
    if (source.kind === "path" && !path.endsWith(".wasm") && !isWasmHeader(bytes)) return;
    this.byPath.set(path, this.addBytes(bytes, path, source));
  }

  // ── source 1 and 2: the program's source text ───────────────────────

  scanFile(sf: ts.SourceFile): void {
    const text = sf.text;
    const paths = text.includes(".wasm") || SHARED_LIBRARY_PATH.test(text);
    const base64 = text.includes(BASE64_MAGIC);
    const bytes = BYTES_MAGIC.test(text);
    if (!paths && !base64 && !bytes) return;
    const file = sf.fileName;
    const lineOf = (node: ts.Node): number =>
      ts.getLineAndCharacterOfPosition(sf, ts.tokenStartOfNode(node)).line + 1;
    ts.walkPreorder(
      sf,
      (node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (base64 && node.text.startsWith(BASE64_MAGIC)) {
            const decoded = decodeBase64(node.text);
            if (decoded !== null && isWasmHeader(decoded)) {
              this.addBytes(decoded, undefined, { kind: "inline", file, line: lineOf(node) });
            }
          }
          return undefined;
        }
        if (ts.isArrayLiteralExpression(node)) {
          if (bytes) {
            const literal = byteArrayLiteral(node);
            if (literal !== null && isWasmHeader(literal)) {
              this.addBytes(literal, undefined, { kind: "inline", file, line: lineOf(node) });
              return "skip";
            }
          }
          return undefined;
        }
        if (!paths) return undefined;
        const path = this.resolvedPath(sf, node);
        if (path !== null) this.addFile(path, { kind: "path", file, line: lineOf(node) });
        return undefined;
      },
      SCAN_KINDS,
    );
  }

  /** The module path a resolution expression names, when it ends in .wasm
   * (or .so). */
  resolvedPath(sf: ts.SourceFile, node: ts.Node): string | null {
    const dir = dirname(sf.fileName);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments.nodes[0];
      if (first === undefined) return null;
      // require.resolve / createRequire(...).resolve / import.meta.resolve
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "resolve") {
        const specifier = wasmLiteral(first);
        if (specifier === null) {
          return this.joinedPath(dir, node.arguments.nodes);
        }
        const receiver = callee.expression;
        if (ts.isMetaProperty(receiver) || isRequireLike(receiver)) {
          if (specifier.startsWith("./") || specifier.startsWith("../")) {
            return resolve(dir, specifier);
          }
          if (isAbsolute(specifier)) return specifier;
          return this.input.resolveRequest(sf.fileName, specifier);
        }
        return null;
      }
      // path.join(__dirname, "x.wasm") and its resolve/bare spellings
      if (
        (ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === "join" || callee.name.text === "resolve")) ||
        (ts.isIdentifier(callee) && (callee.text === "join" || callee.text === "resolve"))
      ) {
        return this.joinedPath(dir, node.arguments.nodes);
      }
      return null;
    }
    if (ts.isNewExpression(node)) {
      // new URL("./x.wasm", import.meta.url)
      if (!ts.isIdentifier(node.expression) || node.expression.text !== "URL") return null;
      const args = node.arguments?.nodes;
      if (args === undefined || args.length !== 2) return null;
      const specifier = wasmLiteral(args[0]!);
      const base = args[1]!;
      if (specifier === null || !isImportMetaUrl(base)) return null;
      if (specifier.startsWith("./") || specifier.startsWith("../")) return resolve(dir, specifier);
      return null;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      // __dirname + "/x.wasm"
      if (!isDirname(node.left)) return null;
      const rest = wasmLiteral(node.right);
      return rest === null ? null : join(dir, rest);
    }
    return null;
  }

  joinedPath(dir: string, args: readonly ts.Expression[]): string | null {
    if (args.length < 2 || !isDirname(args[0]!)) return null;
    const parts: string[] = [dir];
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null;
      parts.push(arg.text);
    }
    if (!isModulePath(parts[parts.length - 1]!)) return null;
    let path = parts[0]!;
    for (let i = 1; i < parts.length; i++) path = resolve(path, parts[i]!);
    return path;
  }

  // ── source 3: package files ─────────────────────────────────────────

  scanPackages(): void {
    const roots = new Map<string, boolean>();
    for (const sf of this.input.files) {
      const root = packageRootOf(sf.fileName);
      if (root === null) continue;
      const mentions = sf.text.includes("WebAssembly");
      roots.set(root, (roots.get(root) ?? false) || mentions);
    }
    for (const [root, mentions] of roots) {
      if (!mentions) continue;
      const found: string[] = [];
      collectWasmFiles(root, 0, found);
      found.sort();
      for (const path of found)
        this.addFile(path, { kind: "package", file: join(root, "package.json") });
    }
  }

  // ── source 4: configuration ─────────────────────────────────────────

  scanConfig(): void {
    const config = readProjectConfig(this.input.entry);
    if (config.manifest !== null) {
      for (const path of config.wasm) {
        this.addFile(path, { kind: "config", file: config.manifest });
      }
    }
    for (const path of this.input.configured) {
      this.addFile(path, { kind: "config", file: path });
    }
  }

  run(): WasmModuleReport[] {
    for (const sf of this.input.files) this.scanFile(sf);
    this.scanPackages();
    this.scanConfig();
    return this.order.map((sha) => this.byHash.get(sha)!);
  }
}

function addSource(report: WasmModuleReport, source: WasmSource): void {
  for (const s of report.sources) {
    if (s.kind === source.kind && s.file === source.file && s.line === source.line) return;
  }
  report.sources.push(source);
}

/** A path that may name a module: `.wasm`, or `.so` for WebAssembly shared
 * libraries (addFile keeps those only when the file is a module). */
function isModulePath(text: string): boolean {
  return text.endsWith(".wasm") || text.endsWith(".so");
}

function wasmLiteral(node: ts.Expression): string | null {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return null;
  return isModulePath(node.text) ? node.text : null;
}

function isDirname(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "__dirname";
}

function isImportMetaUrl(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression)
  );
}

/** `require`, a `createRequire(...)` call, or a binding named like one. */
function isRequireLike(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "require" || /require$/i.test(node.text);
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    return (
      (ts.isIdentifier(callee) && callee.text === "createRequire") ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire")
    );
  }
  return false;
}

/** The bytes of an array literal of integer literals, or null. */
function byteArrayLiteral(node: ts.ArrayLiteralExpression): Uint8Array | null {
  const elements = node.elements.nodes;
  const out = new Uint8Array(elements.length);
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (!ts.isNumericLiteral(element)) return null;
    const value = Number(element.text);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out[i] = value;
  }
  return out;
}

/** The root directory of the npm package that contains `file` (the
 * directory below its innermost node_modules), or null outside one. */
export function packageRootOf(file: string): string | null {
  const marker = "/node_modules/";
  const at = file.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = file.slice(at + marker.length);
  const segments = rest.split("/");
  const take = segments[0]!.startsWith("@") ? 2 : 1;
  if (segments.length <= take) return null;
  return file.slice(0, at + marker.length) + segments.slice(0, take).join("/");
}

function collectWasmFiles(dir: string, depth: number, out: string[]): void {
  const entries = trackedAccessibleEntries(dir);
  if (entries === null) return;
  for (const name of entries.files) if (name.endsWith(".wasm")) out.push(join(dir, name));
  if (depth >= PACKAGE_SCAN_DEPTH) return;
  for (const name of entries.directories) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    collectWasmFiles(join(dir, name), depth + 1, out);
  }
}

/** Every WebAssembly module the program's sources, packages and
 * configuration make visible to the build, in discovery order. */
export function discoverWasmModules(input: WasmDiscoveryInput): WasmModuleReport[] {
  return new Discovery(input).run();
}
