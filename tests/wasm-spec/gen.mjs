/* Regenerates the executed WebAssembly spec-test corpus programs
 * (tests/corpus/webassembly-spec-<group>/data.mjs): the binary modules and
 * the commands of selected .wast files of the WebAssembly 2.0 core suite,
 * which runner.mjs instantiates and invokes under Node and as a compiled
 * binary. The differential harness compares the two outputs, so V8 is the
 * oracle; the modules are inline base64 literals, which the build
 * discovers and translates.
 *
 *   node tests/wasm-spec/gen.mjs --wast2json <wabt>/bin/wast2json \
 *     --spec <WebAssembly/spec at tag wg-2.0>/test/core
 *
 * Left out: modules given as text, modules the decoder does not accept
 * within the translatable feature level and every command that targets
 * them, and commands with v128 values. The runner's spectest module
 * provides the harness's memory and table (new WebAssembly.Memory and
 * Table), so modules that import them run. Also left out, because they test NaN payloads, which neither
 * side preserves the way the other does: actions whose f32 or f64
 * arguments are NaNs other than the canonical quiet NaN (V8 and scriptc
 * carry NaN payloads through JavaScript numbers differently), and
 * float_exprs.wast's actions that pass a signaling NaN's bit pattern to
 * arithmetic that must quiet it (LLVM may fold `x - 0.0` to `x`, leaving
 * the payload; WebAssembly requires a quiet NaN). Files with more than
 * MAX_ACTIONS actions keep an evenly spaced
 * sample of them (every module and register command stays), which keeps
 * the generated programs small.
 *
 * Commands are compact tuples (runner.mjs reads them):
 *   ["file", name]
 *   ["module", line, moduleIndex, name?]       instantiate, make current
 *   ["instantiate", line, moduleIndex]         assert_un{linkable,instantiable}
 *   ["register", as, name?]
 *   ["invoke" | "get", line, name | 0, field, args]   args: "type:value"
 * The suite's tests are Apache-2.0 licensed (WebAssembly Community
 * Group). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { analyzeWasm } from "../../packages/compiler/dist/wasm/binary.js";

export const GROUPS = {
  int: ["i32", "i64", "int_exprs", "int_literals", "conversions", "traps"],
  float: [
    "f32",
    "f64",
    "f32_cmp",
    "f64_cmp",
    "f32_bitwise",
    "f64_bitwise",
    "float_exprs",
    "float_literals",
    "float_misc",
  ],
  control: [
    "block",
    "br",
    "br_if",
    "br_table",
    "call",
    "call_indirect",
    "fac",
    "forward",
    "func",
    "func_ptrs",
    "if",
    "labels",
    "loop",
    "local_get",
    "local_set",
    "local_tee",
    "nop",
    "return",
    "select",
    "stack",
    "switch",
    "unreachable",
    "unwind",
    "left-to-right",
    "global",
    "start",
  ],
  memory: [
    "address",
    "align",
    "endianness",
    "float_memory",
    "load",
    "store",
    "memory",
    "memory_grow",
    "memory_redundancy",
    "memory_size",
    "memory_trap",
    "bulk",
    "memory_copy",
    "memory_fill",
    "memory_init",
    "data",
  ],
  table: [
    "table_copy",
    "table_fill",
    "table_get",
    "table_grow",
    "table_init",
    "table_set",
    "table_size",
    "elem",
    "ref_func",
    "ref_is_null",
    "ref_null",
    "exports",
    "linking",
  ],
  imports: ["imports", "table", "names"],
};

const MAX_ACTIONS = 400;

const { values } = parseArgs({
  options: { wast2json: { type: "string" }, spec: { type: "string" } },
});
const repo = join(dirname(new URL(import.meta.url).pathname), "../..");

// Writes control and format characters (names.wast has several) as escapes, so the
// generated file holds the same strings without invisible characters in its source.
function escapeInvisible(literal) {
  return literal.replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
}

function value(v) {
  if (v.type === "v128") return null;
  return `${v.type}:${v.value}`;
}

/** Whether a "type:value" argument is a NaN other than the canonical
 * quiet one. */
function oddNaN(arg) {
  const [type, text] = arg.split(":");
  if (type === "f32") {
    const bits = Number(text);
    return (bits & 0x7f800000) === 0x7f800000 && (bits & 0x7fffff) !== 0 && (bits & 0x7fffffff) !== 0x7fc00000;
  }
  if (type === "f64") {
    const bits = BigInt(text);
    const exp = 0x7ff0000000000000n;
    const mantissa = bits & 0xfffffffffffffn;
    return (bits & exp) === exp && mantissa !== 0n && (bits & 0x7fffffffffffffffn) !== 0x7ff8000000000000n;
  }
  return false;
}

/** Whether a "type:value" integer argument is the bit pattern of a
 * signaling NaN. */
function signalingPattern(arg) {
  const [type, text] = arg.split(":");
  if (type === "i32") {
    const bits = Number(text) >>> 0;
    return (bits & 0x7fc00000) === 0x7f800000 && (bits & 0x3fffff) !== 0;
  }
  if (type === "i64") {
    const bits = BigInt.asUintN(64, BigInt(text));
    return (bits & 0x7ff8000000000000n) === 0x7ff0000000000000n && (bits & 0x7ffffffffffffn) !== 0n;
  }
  return false;
}

/** Keeps every structural command and an evenly spaced sample of at most
 * MAX_ACTIONS actions. */
function sample(commands) {
  const actions = commands.filter((c) => c[0] === "invoke" || c[0] === "get").length;
  if (actions <= MAX_ACTIONS) return commands;
  const step = actions / MAX_ACTIONS;
  let seen = 0;
  let next = 0;
  return commands.filter((c) => {
    if (c[0] !== "invoke" && c[0] !== "get") return true;
    const keep = seen >= next;
    seen++;
    if (keep) next += step;
    return keep;
  });
}

for (const [group, names] of Object.entries(GROUPS)) {
  const modules = [];
  const moduleIndex = new Map();
  const commands = [];
  for (const name of names) {
    const dir = mkdtempSync(join(tmpdir(), "wasm-spec-"));
    try {
      execFileSync(values.wast2json, [join(values.spec, `${name}.wast`), "-o", join(dir, "x.json")], {
        stdio: "pipe",
      });
      const json = JSON.parse(readFileSync(join(dir, "x.json"), "utf8"));
      const fileCommands = [["file", `${name}.wast`]];
      // Module names that refer to a module left out: their commands go too.
      const skipped = new Set();
      let current = null;
      let currentSkipped = false;
      for (const c of json.commands) {
        const where = c.line;
        if (c.type === "module" || c.type === "assert_uninstantiable" || c.type === "assert_unlinkable") {
          if (c.module_type === "text" || !c.filename?.endsWith(".wasm")) {
            if (c.type === "module") {
              currentSkipped = true;
              if (c.name) skipped.add(c.name);
            }
            continue;
          }
          const bytes = readFileSync(join(dir, c.filename));
          const summary = analyzeWasm(new Uint8Array(bytes));
          if (summary.status !== "valid") {
            if (c.type === "module") {
              currentSkipped = true;
              if (c.name) skipped.add(c.name);
            }
            continue;
          }
          const b64 = bytes.toString("base64");
          let index = moduleIndex.get(b64);
          if (index === undefined) {
            index = modules.length;
            modules.push(b64);
            moduleIndex.set(b64, index);
          }
          if (c.type === "module") {
            current = c.name ?? null;
            currentSkipped = false;
            fileCommands.push(["module", where, index, ...(c.name ? [c.name] : [])]);
          } else {
            fileCommands.push(["instantiate", where, index]);
          }
          continue;
        }
        if (c.type === "register") {
          const target = c.name ?? current;
          if ((c.name ? skipped.has(c.name) : currentSkipped)) continue;
          fileCommands.push(["register", c.as, ...(target ? [target] : [])]);
          continue;
        }
        if (!c.action) continue;
        const a = c.action;
        const target = a.module ?? null;
        if (target ? skipped.has(target) : currentSkipped) continue;
        const args = (a.args ?? []).map(value);
        const expected = (c.expected ?? []).map(value);
        if (args.includes(null) || expected.includes(null)) continue;
        if (args.some(oddNaN)) continue;
        if (name === "float_exprs" && args.some(signalingPattern)) continue;
        fileCommands.push([a.type === "get" ? "get" : "invoke", where, target ?? 0, a.field, args]);
      }
      commands.push(...sample(fileCommands));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const out = join(repo, `tests/corpus/webassembly-spec-${group}`);
  mkdirSync(out, { recursive: true });
  const header = `/* Generated by tests/wasm-spec/gen.mjs from the WebAssembly 2.0 core test
 * suite (WebAssembly/spec wg-2.0, Apache-2.0) with wabt 1.0.37 wast2json:
 * ${names.map((n) => `${n}.wast`).join(", ")}. Do not edit. */\n`;
  const body =
    `export const modules = [\n${modules.map((m) => `  "${m}",`).join("\n")}\n];\n` +
    `export const script = ${escapeInvisible(JSON.stringify(JSON.stringify(commands)))};\n`;
  writeFileSync(join(out, "data.mjs"), header + body);
  writeFileSync(
    join(out, "main.mjs"),
    `// Executes WebAssembly spec tests (${names.length} files); see tests/wasm-spec/runner.mjs.\nimport { run } from "../../wasm-spec/runner.mjs";\nimport { modules, script } from "./data.mjs";\n\nrun(modules, script);\n`,
  );
  console.log(`${group}: ${modules.length} modules, ${commands.length} commands`);
}
