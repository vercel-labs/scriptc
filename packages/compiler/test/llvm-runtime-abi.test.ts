/* The LLVM backend's runtime ABI guard: every `declare` of a scr_* symbol
 * the emitter produces must agree with the C prototype in scr_runtime.h —
 * parameter count, integer width, pointer-ness, return type, and
 * variadic-ness. The C backend gets this checked for free (clang
 * type-checks its calls against the header), but a .ll `declare` is taken
 * on faith by the linker, so a disagreement is silent UB that can run
 * clean under one toolchain and misbehave under another. This test kills
 * the class mechanically, from four directions:
 *
 *  1. Source scan: every fully-literal `declare ... @scr_*` template
 *     string in the backend/llvm sources is checked against the header.
 *  2. Emitted scan: a curated fs/path/os-heavy corpus slice compiles
 *     through the LLVM backend and every `declare @scr_*` in the emitted
 *     .ll — including the generic LIB_FN_SYMS path, whose signatures are
 *     derived from IR arg types per call site — is checked the same way.
 *  3. Name-existence scan: every scr_* symbol name the backend sources
 *     can EVER put in a .ll — the static string tables (LIB_FN_SYMS and
 *     friends, whose signatures only exist per call site so neither scan
 *     above sees an unexercised entry) plus every literal @scr_* template
 *     reference — must exist in the header as a prototype or an extern
 *     data symbol. This is what catches a two-string name skew (table
 *     says scr_foo_bar, runtime defines scr_foobar) at test time instead
 *     of at the user's link step.
 *  4. Structural layout: compile-time C assertions pin every ScrBytes
 *     size/alignment/offset fact used by LLVM's direct typed-array GEPs.
 *     A runtime-header layout edit therefore fails here instead of becoming
 *     silent cross-language memory corruption.
 *
 * The header parser fails LOUDLY on any C type it cannot map so it can
 * never silently fall behind the header. */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { resolveCc, runtimeSrcDir } from "../src/backend/native-toolchain.js";
import { RUNTIME_ABI_MARKER } from "../src/backend/runtime-abi.js";
import type { IrModule } from "../src/ir/ir.js";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

const repoRoot = join(import.meta.dirname, "../../..");
const headerPath = join(repoRoot, "packages/runtime/src/scr_runtime.h");
const llvmSrcDir = join(import.meta.dirname, "../src/backend/llvm");
const corpusDir = join(repoRoot, "tests/corpus");

/** The emitted-scan slice: in-tier programs that collectively exercise the
 * fs/path/os/crypto/fs.promises/scandir/stats surfaces — the family where
 * a declare/prototype mismatch has bitten. Small on purpose (each entry is
 * a full compile); the source scan above covers the literal declares of
 * every other surface. */
const EMIT_FIXTURES = [
  "1541-fs-readdir-dirent.ts",
  "957-builtins-namespace.ts",
  "992-fs-roundtrip.ts",
  "993-fs-readdir.ts",
  "994-fs-errors.ts",
  "996-fs-rc-stress.ts",
  "997-fs-modules/main.ts",
  "1006-json-fs-config.ts",
];

interface CProto {
  ret: string;
  params: string[];
  variadic: boolean;
}

const LL_I64_TYPES = new Set([
  "size_t", "ssize_t", "int64_t", "uint64_t", "intptr_t", "uintptr_t",
  "long", "long long", "unsigned long", "unsigned long long",
]);
const LL_I32_TYPES = new Set(["int", "int32_t", "uint32_t", "unsigned", "unsigned int"]);

interface HeaderTypes {
  enums: ReadonlySet<string>;
  ptrTypedefs: ReadonlySet<string>;
}

/** C type → the LLVM type the emitter must use for it. Throws on anything
 * unrecognized so header growth can never slip past the guard unmapped. */
function cTypeToLl(raw: string, types: HeaderTypes): string {
  const t = raw.replace(/\b(const|struct|restrict|volatile|extern|_Noreturn)\b/g, " ").replace(/\s+/g, " ").trim();
  if (t.includes("*")) return "ptr";
  if (t === "void") return "void";
  if (t === "double") return "double";
  if (t === "bool" || t === "_Bool") return "i1";
  if (t === "char" || t === "signed char" || t === "unsigned char" || t === "int8_t" || t === "uint8_t") return "i8";
  if (t === "short" || t === "unsigned short" || t === "int16_t" || t === "uint16_t") return "i16";
  if (t === "va_list") return "ptr"; // decays to a pointer in a parameter list on our targets
  if (LL_I64_TYPES.has(t)) return "i64";
  if (LL_I32_TYPES.has(t)) return "i32";
  if (types.enums.has(t)) return "i32"; // C enums are int-sized on every supported target
  if (types.ptrTypedefs.has(t)) return "ptr"; // typedef'd function pointers (ScrTraceFn, ...)
  throw new Error(`scr_runtime.h uses a C type this guard cannot map: "${raw}" — extend cTypeToLl`);
}

/** A parameter is "type [name]" — try the whole text as a type first (the
 * unnamed-parameter form), then with the trailing identifier dropped. */
function cParamToLl(param: string, types: HeaderTypes): string {
  if (param.includes("(")) return "ptr"; // function-pointer parameter
  if (param.includes("[")) return "ptr"; // array parameter — decays to a pointer
  try {
    return cTypeToLl(param, types);
  } catch {
    const m = /^(.*?)\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.exec(param);
    if (m && m[1]!.trim() !== "") return cTypeToLl(m[1]!, types);
    throw new Error(`scr_runtime.h parameter this guard cannot parse: "${param}"`);
  }
}

/** Split a C parameter list on top-level commas (function-pointer
 * parameters carry nested parens). */
function splitParams(argsText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of argsText) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Parse scr_runtime.h into name → prototype, plus the extern data
 * symbols (vtable globals and the like) the emitter references by name.
 * Only `;`-terminated prototypes count: a `static inline` definition has
 * no linkage symbol the emitter could declare, so a declare against one
 * must report as missing. */
async function parseHeader(): Promise<{ protos: Map<string, CProto>; dataSyms: Set<string> }> {
  const raw = await readFile(headerPath, "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/^[ \t]*#[^\n]*$/gm, " ");
  const enums = new Set<string>();
  for (const m of src.matchAll(/typedef\s+enum(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\{[^}]*\}\s*([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) {
    enums.add(m[1]!);
  }
  const ptrTypedefs = new Set<string>();
  for (const m of src.matchAll(/typedef\s+[^;{()]*\(\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*\(/g)) {
    ptrTypedefs.add(m[1]!);
  }
  const types: HeaderTypes = { enums, ptrTypedefs };
  const protos = new Map<string, CProto>();
  for (const m of src.matchAll(/\b(scr_[a-z0-9_]+)\s*\(/g)) {
    const name = m[1]!;
    // Balance parens forward from the opening one; a prototype ends `);`.
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    const after = src.slice(end + 1).match(/^\s*(.)/);
    if (after?.[1] !== ";") continue; // a definition, macro use, or call — not a prototype
    // The return type sits between the previous declaration boundary and
    // the name; anything that doesn't look like one (a parameter list we
    // matched inside, a typedef) is skipped.
    const before = src.slice(0, m.index);
    const boundary = Math.max(before.lastIndexOf(";"), before.lastIndexOf("}"), before.lastIndexOf("{"));
    const retText = before.slice(boundary + 1).replace(/\s+/g, " ").trim();
    if (retText === "" || !/^[A-Za-z_][A-Za-z0-9_ *]*[ *]$/.test(`${retText} `)) continue;
    if (/\btypedef\b/.test(retText)) continue;
    const argsText = src.slice(m.index + m[0].length, end).replace(/\s+/g, " ").trim();
    const parts = argsText === "" || argsText === "void" ? [] : splitParams(argsText);
    const variadic = parts[parts.length - 1] === "...";
    const params = (variadic ? parts.slice(0, -1) : parts).map((p) => cParamToLl(p, types));
    protos.set(name, { ret: cTypeToLl(retText, types), params, variadic });
  }
  const dataSyms = new Set<string>();
  for (const m of src.matchAll(/\bextern\s+[^;(){}]*?\b(scr_[a-z0-9_]+)\s*(?:\[[^\]]*\])?\s*;/g)) {
    dataSyms.add(m[1]!);
  }
  return { protos, dataSyms };
}

interface LlDeclare {
  ret: string;
  name: string;
  params: string[];
  variadic: boolean;
}

/** `declare zeroext i1 @scr_x(ptr, i1 zeroext, ...)` → shape (parameter
 * attributes stripped; only the type words matter for the C prototype). */
function parseDeclare(text: string): LlDeclare | undefined {
  const m = /^declare\s+(.+?)\s*@([A-Za-z0-9_$.]+)\((.*)\)$/.exec(text.trim());
  if (!m) return undefined;
  const ret = m[1]!.replace(/\b(zeroext|signext|noalias|nonnull)\b/g, " ").replace(/\s+/g, " ").trim();
  const parts = m[3]!.trim() === "" ? [] : m[3]!.split(",").map((p) =>
    p.replace(/\b(zeroext|signext|noalias|nonnull)\b/g, " ").replace(/\s+/g, " ").trim(),
  );
  const variadic = parts[parts.length - 1] === "...";
  return { ret, name: m[2]!, params: variadic ? parts.slice(0, -1) : parts, variadic };
}

function checkDeclare(d: LlDeclare, protos: Map<string, CProto>): string | undefined {
  const proto = protos.get(d.name);
  if (!proto) return `${d.name}: declared by the LLVM backend but scr_runtime.h has no prototype`;
  const issues: string[] = [];
  if (d.ret !== proto.ret) issues.push(`return ${d.ret} vs C ${proto.ret}`);
  if (d.params.length !== proto.params.length) {
    issues.push(`${d.params.length} params vs C ${proto.params.length}`);
  } else {
    for (let i = 0; i < proto.params.length; i++) {
      if (d.params[i] !== proto.params[i]) issues.push(`param ${i} is ${d.params[i]} vs C ${proto.params[i]}`);
    }
  }
  if (d.variadic !== proto.variadic) issues.push(`variadic ${d.variadic} vs C ${proto.variadic}`);
  if (issues.length === 0) return undefined;
  return `${d.name}: ${issues.join("; ")} — declare "${d.ret} (${[...d.params, ...(d.variadic ? ["..."] : [])].join(", ")})"`;
}

describe("LLVM backend declares match scr_runtime.h prototypes", () => {
  test("externally linkable objects reference the versioned runtime marker", async () => {
    const loc = { file: "/source/abi-marker.ts", start: 0, end: 0 };
    const mod: IrModule = {
      irVersion: 1,
      sourceFile: loc.file,
      entry: "%main",
      functions: [{
        id: "%main",
        name: "main",
        params: [],
        locals: [],
        returnType: { kind: "void" },
        body: [{ kind: "return", value: null, loc }],
        loc,
      }],
    };
    const llvm = emitLlvmModule(mod, { runtimeAbiMarker: true });
    expect(llvm).toContain(`declare void @${RUNTIME_ABI_MARKER}()`);
    expect(llvm).toContain(`call void @${RUNTIME_ABI_MARKER}()`);
    expect(await readFile(headerPath, "utf8")).toContain(`void ${RUNTIME_ABI_MARKER}(void);`);
    expect(await readFile(join(repoRoot, "packages/runtime/src/scr_console.c"), "utf8"))
      .toContain(`void ${RUNTIME_ABI_MARKER}(void) {}`);
  });
  test("ScrBytes structural type matches the C runtime layout", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "scriptc-llvm-layout-"));
    const cPath = join(outDir, "scr-bytes-layout.c");
    const objectPath = join(outDir, "scr-bytes-layout.o");
    await writeFile(
      cPath,
      `#include <stddef.h>
#include <stdint.h>
#include "scr_runtime.h"

/* LLVM emits: %ScrBytes = type { i64, i64, i32, ptr, ptr }.
 * Keep every ABI fact used by its field-index GEPs explicit here. */
_Static_assert(sizeof(size_t) == 8, "LLVM ScrBytes expects 64-bit size_t");
_Static_assert(sizeof(void *) == 8, "LLVM ScrBytes expects 64-bit pointers");
_Static_assert(sizeof(ScrBytesElem) == 4, "LLVM ScrBytes elem field is i32");
_Static_assert(_Alignof(ScrBytes) == 8, "LLVM ScrBytes alignment changed");
_Static_assert(sizeof(ScrBytes) == 40, "LLVM ScrBytes size changed");
_Static_assert(offsetof(ScrBytes, rc) == 0, "LLVM ScrBytes.rc offset changed");
_Static_assert(offsetof(ScrBytes, len) == 8, "LLVM ScrBytes.len offset changed");
_Static_assert(offsetof(ScrBytes, elem) == 16, "LLVM ScrBytes.elem offset changed");
_Static_assert(offsetof(ScrBytes, data) == 24, "LLVM ScrBytes.data offset changed");
_Static_assert(offsetof(ScrBytes, backing) == 32, "LLVM ScrBytes.backing offset changed");
`,
    );
    const driver = resolveCc();
    await execFileAsync(driver.argv[0]!, [
      ...driver.argv.slice(1),
      ...driver.targetArgs,
      "-std=c11",
      "-I",
      runtimeSrcDir(),
      "-c",
      cPath,
      "-o",
      objectPath,
    ]);
  });

  test("every literal declare in the backend sources", async () => {
    const { protos } = await parseHeader();
    const failures: string[] = [];
    let checked = 0;
    for (const file of await readdir(llvmSrcDir)) {
      if (!file.endsWith(".ts")) continue;
      const src = await readFile(join(llvmSrcDir, file), "utf8");
      // Fully-literal declares only: an interpolated symbol or signature is
      // per-call-site and covered by the emitted scan below.
      for (const m of src.matchAll(/declare\s+[^`$]*?@scr_[a-z0-9_]+\([^`$)]*\)/g)) {
        const d = parseDeclare(m[0]);
        if (!d) continue;
        checked++;
        const issue = checkDeclare(d, protos);
        if (issue !== undefined) failures.push(`${file}: ${issue}`);
      }
    }
    // The extractor guard: the backend sources carry well over a hundred
    // literal declares — finding almost none means the regex rotted, not
    // that the emitter went quiet.
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });

  test("every scr_* name the backend sources can emit exists in the header", async () => {
    const { protos, dataSyms } = await parseHeader();
    const names = new Map<string, string>(); // name → first file seen in
    for (const file of await readdir(llvmSrcDir)) {
      if (!file.endsWith(".ts")) continue;
      const src = await readFile(join(llvmSrcDir, file), "utf8");
      // The static string tables: every double-quoted scr_* literal is a
      // symbol name some path can hand to the .ll (LIB_FN_SYMS et al.).
      for (const m of src.matchAll(/"(scr_[a-z0-9_]+)"/g)) {
        if (!names.has(m[1]!)) names.set(m[1]!, file);
      }
      // Literal @scr_* references inside template strings (declares AND
      // call sites). A reference whose name continues with `${...}` is an
      // interpolated per-type family (scr_arr_get_${suffix}) — the full
      // name only exists per suffix, so those ride the emitted scan.
      for (const m of src.matchAll(/@(scr_[a-z0-9_]+)/g)) {
        if (src.startsWith("${", m.index + m[0].length)) continue;
        if (!names.has(m[1]!)) names.set(m[1]!, file);
      }
    }
    const failures: string[] = [];
    for (const [name, file] of names) {
      if (protos.has(name) || dataSyms.has(name)) continue;
      failures.push(`${file}: ${name} — the backend can emit this symbol but scr_runtime.h declares no such prototype or extern data symbol`);
    }
    // Extractor guard: the tables alone carry hundreds of names — finding
    // few means the scan rotted, not that the backend went quiet.
    expect(names.size).toBeGreaterThan(400);
    expect(failures).toEqual([]);
  });

  test("every declare emitted for the fs/path corpus slice", async () => {
    const { protos } = await parseHeader();
    const failures: string[] = [];
    const seen = new Set<string>();
    for (const fixture of EMIT_FIXTURES) {
      const outDir = await mkdtemp(join(tmpdir(), "scriptc-llvm-abi-"));
      const res = await compile(join(corpusDir, fixture), {
        outPath: join(outDir, "program"),
        outDir,
        backend: "llvm",
      });
      if (!res.ok) {
        throw new Error(
          `${fixture} left the LLVM tier (${res.diagnostics[0]?.message ?? "?"}) — swap in an in-tier fs fixture`,
        );
      }
      const ll = await readFile(res.cPath, "utf8");
      for (const line of ll.split("\n")) {
        if (!line.startsWith("declare ")) continue;
        const d = parseDeclare(line);
        if (!d || !d.name.startsWith("scr_")) continue;
        const key = line.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const issue = checkDeclare(d, protos);
        if (issue !== undefined) failures.push(`${fixture}: ${issue}`);
      }
    }
    expect(seen.size).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  });
});
