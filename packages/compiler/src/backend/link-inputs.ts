/** Files a link input names indirectly, which the link trace does not list.
 *
 * A linker input can stand for files other than itself. A GNU ld linker script
 * names the scripts it includes and the inputs and groups it adds, and a thin
 * archive stores its members as paths instead of content. The executable
 * cache's proof snapshots the inputs the driver opened, so it also has to
 * snapshot these named files: otherwise a rebuilt archive member or an edited
 * included script leaves an executable the cache restores from stale inputs.
 *
 * Resolution over-approximates on purpose. The linker resolves a relative name
 * against search paths the compiler does not model exactly (the script's
 * directory, the working directory, SEARCH_DIR), so every existing candidate
 * is recorded. Recording a file the linker did not open only makes a later
 * build redo the link; missing a file it did open is a stale executable.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface LinkInputExpansionOptions {
  /** The link's working directory. */
  cwd: string;
  /** Inputs the proof already owns; a named file under one is not added. */
  excludedRoots?: readonly string[];
  /** Files a link input may name. A larger set keeps the proof unpublished. */
  maxFiles?: number;
}

/** The largest text input inspected as a script. Linker scripts are a few
 * kilobytes; anything larger is not one, and reading it would cost a build. */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
/** The largest thin archive inspected. Members are not stored, so real ones
 * are small; a larger file is refused rather than partially read. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Includes, groups, and member archives nest a few levels at most. */
const MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 10_000;

/** The existing files `inputs` name besides themselves: the files a linker
 * script includes or adds, and the members of a thin archive. Absolute paths,
 * sorted, excluding the inputs themselves and anything under `excludedRoots`. */
export async function namedLinkInputDependencies(
  inputs: readonly string[],
  options: LinkInputExpansionOptions,
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const excluded = (options.excludedRoots ?? []).map((root) => resolve(root));
  const named = new Set<string>();
  const visited = new Set<string>();
  let pending = inputs.map((input) => resolve(options.cwd, input));
  for (let depth = 0; depth <= MAX_DEPTH && pending.length > 0; depth++) {
    const next: string[] = [];
    for (const path of pending) {
      if (visited.has(path)) continue;
      visited.add(path);
      for (const dependency of await namedInputs(path, options.cwd)) {
        if (visited.has(dependency) || named.has(dependency)) continue;
        if (excluded.some((root) => isUnder(dependency, root))) continue;
        named.add(dependency);
        if (named.size > maxFiles)
          throw new Error(`link input ${path} names more than ${maxFiles} files`);
        next.push(dependency);
      }
    }
    pending = next;
  }
  // Deeper nesting is not refused silently: a named input's own names stay
  // unread, so the proof cannot cover them.
  if (pending.length > 0) throw new Error(`link inputs nest deeper than ${MAX_DEPTH} levels`);
  return [...named].sort();
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

const ARCHIVE_MAGIC = "!<arch>\n";
const THIN_ARCHIVE_MAGIC = "!<thin>\n";

async function namedInputs(path: string, cwd: string): Promise<string[]> {
  let size: number;
  try {
    const info = statSync(path);
    if (!info.isFile()) return [];
    size = info.size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  const head = readPrefix(path, Math.min(size, 8));
  const magic = head.toString("latin1");
  if (magic === THIN_ARCHIVE_MAGIC) {
    if (size > MAX_ARCHIVE_BYTES) throw new Error(`thin archive too large to prove: ${path}`);
    return thinArchiveMembers(await readFile(path), dirname(path), cwd);
  }
  // A regular archive contains its members, and an object or library file has
  // no named inputs, so neither adds a dependency.
  if (magic === ARCHIVE_MAGIC) return [];
  const prefix = readPrefix(path, Math.min(size, 512));
  if (looksBinary(prefix)) return [];
  if (size > MAX_SCRIPT_BYTES) throw new Error(`text input too large to prove: ${path}`);
  return linkerScriptInputs(await readFile(path, "utf8"), dirname(path), cwd);
}

function readPrefix(path: string, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const BINARY_MAGIC = [
  "\x7fELF", // ELF object or shared library
  "\xca\xfe\xba\xbe", // Mach-O universal
  "\xfe\xed\xfa\xce", // Mach-O 32-bit big-endian
  "\xfe\xed\xfa\xcf", // Mach-O 64-bit big-endian
  "\xce\xfa\xed\xfe", // Mach-O 32-bit little-endian
  "\xcf\xfa\xed\xfe", // Mach-O 64-bit little-endian
  "\x00asm", // WebAssembly module
  "BC\xc0\xde", // LLVM bitcode
];

function looksBinary(prefix: Buffer): boolean {
  for (let index = 0; index < prefix.length; index++) if (prefix[index] === 0) return true;
  const text = prefix.toString("latin1");
  if (BINARY_MAGIC.some((magic) => text.startsWith(magic))) return true;
  // A PE file starts with the DOS stub.
  return text.startsWith("MZ");
}

/** A thin archive stores no member content: each regular member header names a
 * file beside the archive (or wherever it was added from), and only the symbol
 * table and long-name table hold data. */
function thinArchiveMembers(bytes: Buffer, archiveDir: string, cwd: string): string[] {
  const members: string[] = [];
  let longNames: Buffer = Buffer.alloc(0);
  let offset = THIN_ARCHIVE_MAGIC.length;
  while (offset + 60 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 60);
    const rawName = header.subarray(0, 16).toString("latin1").trim();
    const size = Number.parseInt(header.subarray(48, 58).toString("latin1").trim(), 10);
    offset += 60;
    if (rawName === "/" || rawName === "//") {
      if (!Number.isFinite(size) || size < 0 || offset + size > bytes.length) break;
      if (rawName === "//") longNames = bytes.subarray(offset, offset + size);
      offset += size;
      continue;
    }
    let name = rawName;
    if (name.startsWith("/") && /^\d+$/.test(name.slice(1))) {
      const start = Number.parseInt(name.slice(1), 10);
      const end = longNames.indexOf(0x0a, start);
      name = longNames.subarray(start, end < 0 ? longNames.length : end).toString("latin1");
    }
    name = name.replace(/\/+$/, "");
    // GNU ar records a relative member path relative to the archive's
    // directory; a link can also run from elsewhere. Check both.
    for (const directory of [archiveDir, cwd])
      for (const candidate of existingCandidates(name, [directory])) members.push(candidate);
    // A thin member's content is elsewhere, so the next header follows the
    // header immediately.
  }
  return members;
}

interface ScriptNames {
  names: string[];
  searchDirectories: string[];
}

function linkerScriptInputs(text: string, scriptDir: string, cwd: string): string[] {
  const tokens = scriptTokens(text);
  const found: ScriptNames = { names: [], searchDirectories: [] };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!.toLowerCase();
    if (token === "include") {
      const name = tokens[index + 1];
      if (name !== undefined) found.names.push(name);
      index += 2;
      continue;
    }
    if (token === "search_dir") {
      index = collectList(tokens, index + 1, (name) => found.searchDirectories.push(name));
      continue;
    }
    if (token === "input" || token === "group" || token === "startup" || token === "as_needed") {
      index = collectList(tokens, index + 1, (name) => found.names.push(name));
      continue;
    }
    index++;
  }
  const searchDirectories = [
    scriptDir,
    cwd,
    ...found.searchDirectories.map((directory) => resolve(scriptDir, directory)),
  ];
  const paths = new Set<string>();
  for (const name of found.names) {
    if (name.startsWith("-l:")) {
      for (const candidate of existingCandidates(name.slice(3), searchDirectories))
        paths.add(candidate);
    } else if (name.startsWith("-l")) {
      // `-lfoo` names libfoo.so or libfoo.a in a search directory.
      for (const directory of searchDirectories)
        for (const candidate of existingCandidates(`lib${name.slice(2)}.so`, [directory]))
          paths.add(candidate);
      for (const directory of searchDirectories)
        for (const candidate of existingCandidates(`lib${name.slice(2)}.a`, [directory]))
          paths.add(candidate);
    } else if (!name.startsWith("-")) {
      for (const candidate of existingCandidates(name, searchDirectories)) paths.add(candidate);
    }
  }
  return [...paths];
}

/** Split a script's commands and names. Comments and punctuation carry no
 * dependency, and a quoted name is one token. */
function scriptTokens(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (character === "#") {
      const end = text.indexOf("\n", index + 1);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "(" || character === ")" || character === "," || character === ";") {
      tokens.push(character);
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      let value = "";
      index++;
      while (index < text.length && text[index] !== character) {
        if (text[index] === "\\" && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
        } else {
          value += text[index];
          index++;
        }
      }
      index++;
      tokens.push(value);
      continue;
    }
    let end = index;
    while (end < text.length && !/[\s(),;]/.test(text[end]!)) end++;
    tokens.push(text.slice(index, end));
    index = end;
  }
  return tokens;
}

/** Names inside the parenthesized list at `open`, through its matching close,
 * following a nested `AS_NEEDED (` list. Returns the index after the list. */
function collectList(
  tokens: readonly string[],
  open: number,
  sink: (name: string) => void,
): number {
  if (tokens[open] !== "(") return open;
  let depth = 1;
  let index = open + 1;
  while (index < tokens.length && depth > 0) {
    const token = tokens[index]!;
    if (token === "(") {
      depth++;
      index++;
      continue;
    }
    if (token === ")") {
      depth--;
      index++;
      continue;
    }
    if (token === "," || token === ";") {
      index++;
      continue;
    }
    if (token.toLowerCase() === "as_needed" && tokens[index + 1] === "(") {
      index = collectList(tokens, index + 1, sink);
      continue;
    }
    sink(token);
    index++;
  }
  return index;
}

/** Every existing candidate for `name`: an absolute path names itself, and a
 * relative path is looked for in each directory. */
function existingCandidates(name: string, directories: readonly string[]): string[] {
  if (name === "") return [];
  if (isAbsolute(name)) return existsSync(name) ? [resolve(name)] : [];
  const candidates = new Set<string>();
  for (const directory of directories) {
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) candidates.add(candidate);
  }
  return [...candidates];
}
