/* Comparison logic for scripts/zero-cost-gate.mjs, kept free of process
 * orchestration so tests/harness/zero-cost-gate.test.ts can pin it.
 *
 * Artifacts are compared as bytes first. Only when they differ are they split
 * into named units (IR functions, LLVM functions, executable symbols) to name
 * the first unit that differs. The self-hosted compiler's IR and LLVM exceed
 * V8's maximum string length, so splitting works on Buffers and hashes each
 * unit instead of decoding the artifact. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (bytes) => createHash("sha1").update(bytes).digest("hex");

/** Named units of an artifact: `order` lists unit keys in artifact order,
 * `hashes` maps each key to a content hash, and `module` holds the
 * module-level remainder (IR header, LLVM globals and declarations) as a list
 * of comparable pieces with their labels. Repeated names get `#n` suffixes. */
function unitsBuilder() {
  const order = [];
  const hashes = new Map();
  const seen = new Map();
  return {
    order,
    hashes,
    module: [],
    add(name, bytes) {
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      const key = count === 0 ? name : `${name}#${count + 1}`;
      order.push(key);
      hashes.set(key, hash(bytes));
    },
  };
}

/* ── IR (compact or readable JSON) ─────────────────────────────────────── */

function skipString(bytes, index) {
  for (index++; index < bytes.length; index++) {
    if (bytes[index] === 0x5c) index++;
    else if (bytes[index] === 0x22) return index + 1;
  }
  return bytes.length;
}

/** Byte ranges of the root object's `"functions"` array elements, or null. */
export function irFunctionSpans(bytes) {
  const key = Buffer.from('"functions"');
  let depth = 0;
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    if (byte === 0x22) {
      const end = skipString(bytes, index);
      if (depth === 1 && end - index === key.length && bytes.subarray(index, end).equals(key)) {
        let next = end;
        while (next < bytes.length && bytes[next] !== 0x3a) next++;
        next++;
        while (next < bytes.length && bytes[next] !== 0x5b && bytes[next] <= 0x20) next++;
        if (bytes[next] === 0x5b) return elementSpans(bytes, next);
      }
      index = end;
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) depth++;
    else if (byte === 0x7d || byte === 0x5d) depth--;
    index++;
  }
  return null;
}

function elementSpans(bytes, open) {
  const spans = [];
  let depth = 0;
  let start = -1;
  for (let index = open + 1; index < bytes.length;) {
    const byte = bytes[index];
    if (byte === 0x22) {
      if (start < 0) start = index;
      index = skipString(bytes, index);
      continue;
    }
    if (byte === 0x7b || byte === 0x5b) {
      if (start < 0) start = index;
      depth++;
    } else if (byte === 0x7d || byte === 0x5d) {
      if (depth === 0) {
        if (start >= 0) spans.push([start, trimEnd(bytes, index)]);
        return { open, close: index, spans };
      }
      depth--;
    } else if (byte === 0x2c && depth === 0) {
      spans.push([start, trimEnd(bytes, index)]);
      start = -1;
    } else if (start < 0 && byte > 0x20) start = index;
    index++;
  }
  return null;
}

function trimEnd(bytes, end) {
  while (end > 0 && bytes[end - 1] <= 0x20) end--;
  return end;
}

/** The `name` of one serialized IR function. Functions serialize `name`
 * first; anything else is parsed (a single function is small). */
function irFunctionName(bytes, [start, end]) {
  const head = bytes.toString("utf8", start, Math.min(end, start + 4096));
  const match = /^\{\s*"name"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
  if (match) return JSON.parse(match[1]);
  const fn = JSON.parse(bytes.toString("utf8", start, end));
  return typeof fn?.name === "string" ? fn.name : "<unnamed>";
}

/** IR units: one per function, plus the module header split by top-level
 * key (and, for arrays, by element) so header differences are named too. */
export function irUnits(bytes) {
  const units = unitsBuilder();
  const located = irFunctionSpans(bytes);
  let header;
  if (located === null) header = JSON.parse(bytes.toString("utf8"));
  else {
    for (const span of located.spans)
      units.add(irFunctionName(bytes, span), bytes.subarray(span[0], span[1]));
    header = JSON.parse(
      bytes.toString("utf8", 0, located.open + 1) + bytes.toString("utf8", located.close),
    );
  }
  for (const [key, value] of Object.entries(header)) {
    if (key === "functions" && located !== null) continue;
    if (Array.isArray(value))
      value.forEach((item, index) => {
        const name = item && typeof item === "object" && "name" in item ? `:${item.name}` : "";
        units.module.push({ label: `${key}[${index}${name}]`, text: JSON.stringify(item) });
      });
    else units.module.push({ label: key, text: JSON.stringify(value) });
  }
  return units;
}

/* ── LLVM text ─────────────────────────────────────────────────────────── */

const DEFINE_NAME = /@("(?:[^"\\]|\\.)*"|[-\w$.]+)\s*\(/;

/** LLVM units: one per `define … { … }` body; every other line is
 * module-level text compared line by line. */
export function llvmUnits(bytes) {
  const units = unitsBuilder();
  let fnStart = -1;
  let fnName = "";
  let lineNumber = 0;
  for (let start = 0; start < bytes.length;) {
    let end = bytes.indexOf(10, start);
    if (end < 0) end = bytes.length;
    lineNumber++;
    if (fnStart >= 0) {
      if (end - start === 1 && bytes[start] === 0x7d) {
        units.add(fnName, bytes.subarray(fnStart, end));
        fnStart = -1;
      }
    } else if (bytes[start] === 0x64 && bytes.toString("latin1", start, start + 7) === "define ") {
      const line = bytes.toString("utf8", start, end);
      fnName = DEFINE_NAME.exec(line)?.[1] ?? `<line ${lineNumber}>`;
      fnStart = start;
      if (line.endsWith("}")) {
        units.add(fnName, bytes.subarray(fnStart, end));
        fnStart = -1;
      }
    } else if (end > start) {
      units.module.push({ label: `line ${lineNumber}`, text: bytes.toString("utf8", start, end) });
    }
    start = end + 1;
  }
  return units;
}

/* ── unit comparison ───────────────────────────────────────────────────── */

const clip = (text, width = 160) => (text.length > width ? `${text.slice(0, width)}…` : text);

/** Compare two unit sets. `first` names the first difference in baseline
 * order: a changed or removed function, then an added one, then the first
 * differing module-level piece. */
export function compareUnits(baseline, candidate) {
  const changed = [];
  const removed = [];
  for (const key of baseline.order) {
    const other = candidate.hashes.get(key);
    if (other === undefined) removed.push(key);
    else if (other !== baseline.hashes.get(key)) changed.push(key);
  }
  const added = candidate.order.filter((key) => !baseline.hashes.has(key));
  let module = null;
  const count = Math.max(baseline.module.length, candidate.module.length);
  for (let index = 0; index < count && module === null; index++) {
    const a = baseline.module[index];
    const b = candidate.module[index];
    if (a?.text !== b?.text)
      module = {
        label: (a ?? b).label,
        baseline: a === undefined ? null : clip(a.text),
        candidate: b === undefined ? null : clip(b.text),
      };
  }
  const firstFunction = baseline.order.find(
    (key) => !candidate.hashes.has(key) || candidate.hashes.get(key) !== baseline.hashes.get(key),
  );
  let first = null;
  if (firstFunction !== undefined)
    first = `${changed.includes(firstFunction) ? "changed" : "removed"} ${firstFunction}`;
  else if (added.length > 0) first = `added ${added[0]}`;
  else if (module !== null) first = `module ${module.label}`;
  else if (baseline.order.join("\n") !== candidate.order.join("\n")) first = "function order";
  return {
    identical: first === null,
    first,
    changed,
    added,
    removed,
    module,
    functions: { baseline: baseline.order.length, candidate: candidate.order.length },
  };
}

/** Byte-compare an artifact and, when it differs, name what changed. */
export function compareArtifact(kind, baseline, candidate) {
  if (baseline.equals(candidate)) return { identical: true };
  const split = kind === "ir" ? irUnits : llvmUnits;
  const result = compareUnits(split(baseline), split(candidate));
  // Equal units with unequal bytes means formatting outside the units.
  return { ...result, identical: false, first: result.first ?? "bytes outside named units" };
}

/* ── executables ───────────────────────────────────────────────────────── */

/** The output of `nm` for `binary`, from its spawnSync result. Throws when
 * nm could not start, was killed by a signal, or exited with a non-zero
 * status, because the symbol checks would otherwise read an empty list. */
export function nmOutput(binary, result) {
  if (result.error) throw new Error(`nm ${binary}: ${result.error.message}`);
  if (result.signal) throw new Error(`nm ${binary}: killed by ${result.signal}`);
  if (result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      `nm ${binary}: exited with status ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

/** Defined symbols from `nm -S` output (GNU/LLVM nm, address size type
 * name) or `nm` output without sizes (Apple, address type name). */
export function parseNm(text) {
  const symbols = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length === 4 && /^[0-9a-f]+$/i.test(fields[1]))
      symbols.push({
        address: BigInt(`0x${fields[0]}`),
        size: BigInt(`0x${fields[1]}`),
        type: fields[2],
        name: fields[3],
      });
    else if (fields.length === 3 && /^[0-9a-f]+$/i.test(fields[0]))
      symbols.push({
        address: BigInt(`0x${fields[0]}`),
        size: null,
        type: fields[1],
        name: fields[2],
      });
  }
  return symbols;
}

/** The virtual address of file offset `offset` in an ELF64 little-endian
 * executable, from its PT_LOAD program headers, or null. */
export function elfOffsetToAddress(bytes, offset) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2) return null;
  const phoff = Number(bytes.readBigUInt64LE(0x20));
  const phentsize = bytes.readUInt16LE(0x36);
  const phnum = bytes.readUInt16LE(0x38);
  for (let index = 0; index < phnum; index++) {
    const at = phoff + index * phentsize;
    if (bytes.readUInt32LE(at) !== 1) continue;
    const fileOffset = bytes.readBigUInt64LE(at + 8);
    const address = bytes.readBigUInt64LE(at + 16);
    const fileSize = bytes.readBigUInt64LE(at + 32);
    const target = BigInt(offset);
    if (target >= fileOffset && target < fileOffset + fileSize)
      return address + (target - fileOffset);
  }
  return null;
}

/** Name what differs between two executables: symbols added, removed or
 * resized, then the symbol holding the first differing byte. */
export function compareExecutables(baseline, candidate, baselineNm, candidateNm) {
  if (baseline.equals(candidate)) return { identical: true };
  const before = new Map(parseNm(baselineNm).map((s) => [s.name, s]));
  const after = new Map(parseNm(candidateNm).map((s) => [s.name, s]));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const added = [...after.keys()].filter((name) => !before.has(name));
  const resized = [...before.values()]
    .filter((s) => after.has(s.name) && s.size !== null && after.get(s.name).size !== s.size)
    .map((s) => ({
      name: s.name,
      baseline: Number(s.size),
      candidate: Number(after.get(s.name).size),
    }));
  let offset = 0;
  const limit = Math.min(baseline.length, candidate.length);
  while (offset < limit && baseline[offset] === candidate[offset]) offset++;
  const address = elfOffsetToAddress(baseline, offset);
  let holder = null;
  if (address !== null)
    for (const s of before.values())
      if (s.size !== null && address >= s.address && address < s.address + s.size) holder = s.name;
  const first =
    resized[0] !== undefined
      ? `resized ${resized[0].name}`
      : removed[0] !== undefined
        ? `removed ${removed[0]}`
        : added[0] !== undefined
          ? `added ${added[0]}`
          : holder !== null
            ? `bytes in ${holder}`
            : `byte offset ${offset}`;
  return { identical: false, first, offset, holder, added, removed, resized };
}

/* ── dynamic-tier symbols (two-tier design, invariant I3) ────────────────── */

/** Runtime symbol prefixes that belong to the dynamic tier: code a fully
 * typed program has no reason to reach. A typed program's release binary
 * must define none of them. Extend this list as dynamic-tier units land
 * (S3/S4 add their scr_js_* families) and as legacy ScrDyn families move.
 * The ScrDyn prefixes are the object-model entry points the two-tier audit
 * (results/design-two-tier/DESIGN.md §3.2-3.3) lists as dynamic-only. */
export const DYNAMIC_TIER_PREFIXES = [
  // Dynamic-tier runtime units (scr_js_value, scr_js_object, ...), from S3.
  "scr_js_",
  // ScrDyn property bags: reads, writes, lookup and key indexing.
  "scr_dyn_obj_",
  "scr_dyn_find_",
  "scr_dyn_index_",
  "scr_dyn_key_",
  "sc_dyn_key_",
  // Descriptors, own-property reflection, prototypes and proxies.
  "scr_dyn_property_",
  "scr_dyn_define_",
  "scr_dyn_descriptor_",
  "scr_dyn_own_",
  "scr_dyn_get_own_",
  "scr_dyn_prototype",
  "scr_dyn_proxy_",
  // Dynamic calls and the dynamic receiver read.
  "scr_dyn_call",
  "scr_dyn_apply",
  "scr_dyn_invoke",
  "scr_dyn_construct",
  "scr_dyn_function_apply",
  "scr_dyn_fn_get",
  "scr_dyn_this_get",
  // Dynamic operators and coercions.
  "scr_dyn_add_",
  "scr_dyn_arithmetic",
  "scr_dyn_to_numeric",
  "scr_dyn_number_coerce",
  "scr_dyn_string_coerce",
];

/** Symbols under those prefixes that typed binaries reach today through a
 * leak the two-tier design schedules for removal (S1). Remove an entry when
 * its leak closes. */
export const DYNAMIC_TIER_EXEMPT = new Map([
  // §3.3 L10: scr_dyn_release's dispose switch, linked whenever any dyn
  // value can be released.
  ["scr_dyn_obj_drop_keys", "L10"],
]);

/** The dynamic-tier symbols among `names`, sorted. */
export function dynamicTierSymbols(names) {
  return [...new Set(names)]
    .filter(
      (name) =>
        DYNAMIC_TIER_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
        !DYNAMIC_TIER_EXEMPT.has(name),
    )
    .sort();
}

/** The Node island runtime (scr_node_island*.c, scope-B design §2.15): no
 * program without a call into Node.js may define any of these. */
export const NODE_ISLAND_PREFIXES = ["scr_node_island", "scr_loop_set_node_island"];

/** The Node island symbols among `names`, sorted. */
export function nodeIslandSymbols(names) {
  return [...new Set(names)]
    .filter((name) => NODE_ISLAND_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .sort();
}

/* Bench workloads whose release binaries link dynamic-tier symbols on
 * b14377864: JSON.parse trees, worker messages, regex exec metadata
 * (two-tier §3.3 L5), and a shared scr_dyn_call/scr_dyn_define_property core
 * not yet traced to its typed root. bench/thread-slots,
 * bench/channel-messages and bench/worker-messages, added later, link them
 * through worker messages:
 * node:worker_threads values are dyn objects. bench/json-unions, added
 * later too, decodes JSON.parse trees. bench/throw-chains, also added
 * later, tests caught values with `instanceof`, as bench/validate-errors
 * does. bench/dynamic-methods and
 * bench/dynamic-properties are untyped JavaScript. bench/regex-replacers,
 * also added later, passes checked-dynamic values to replace callbacks
 * whose parameters the lib types `any`: captures a match can leave unset
 * and results the checker types `any`. bench/record-untyped-writes, also
 * added later, writes typed records through `unknown` and `Object.assign`
 * views. Every other bench workload is fully typed and must link none. The gate and
 * tests/harness/bench-dynamic-tier.test.ts enforce that, and the test also
 * fails when a listed workload stops linking them, so remove a workload here
 * when a leak fix makes its binary clean. */
export const DYNAMIC_WORKLOADS = new Set([
  "bench/json-records",
  "bench/cli-config",
  "bench/http-api",
  "bench/validate-errors",
  "bench/regex-logs",
  "bench/atomics-contended",
  "bench/intern-table",
  "bench/thread-slots",
  "bench/channel-messages",
  "bench/dynamic-methods",
  "bench/dynamic-properties",
  "bench/worker-messages",
  "bench/typed-array-scan-workers",
  "bench/log-summary",
  "bench/inventory-report",
  "bench/line-reader",
  "bench/json-unions",
  "bench/throw-chains",
  "bench/regex-replacers",
  "bench/record-untyped-writes",
]);

/** Names of the functions (text and weak symbols) in `nm` output. Mach-O
 * prefixes C names with an underscore; on Darwin it is dropped so the names
 * match DYNAMIC_TIER_PREFIXES as they do on ELF. */
export function definedFunctionNames(text, platform = process.platform) {
  return parseNm(text)
    .filter((s) => /^[tTwW]$/.test(s.type))
    .map((s) => (platform === "darwin" && s.name.startsWith("_") ? s.name.slice(1) : s.name));
}

/* ── cachegrind ────────────────────────────────────────────────────────── */

/** Background threads whose instruction counts depend on scheduling: the
 * allocator's prefault thread. */
export const CACHEGRIND_EXCLUDED = new Set(["scr_sa_pf_main", "scr_sa_prefault"]);

/** Per-function instruction counts (Ir) from a cachegrind output file,
 * restricted to `keep` (the executable's own defined symbols). Dynamic
 * linker and libc/pthread functions are outside `keep`; their counts vary
 * run to run with lazy binding and thread wakeups. */
export function cachegrindCounts(text, keep) {
  const counts = new Map();
  let events = null;
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("events:")) events = line.slice(7).trim().split(/\s+/);
    else if (line.startsWith("fn=")) {
      const name = line.slice(3).trim();
      current = keep.has(name) && !CACHEGRIND_EXCLUDED.has(name) ? name : null;
    } else if (line.startsWith("fl=") || line.startsWith("fi=") || line.startsWith("fe=")) continue;
    else if (current !== null && /^\d/.test(line)) {
      const fields = line.trim().split(/\s+/);
      const column = events === null ? 0 : Math.max(0, events.indexOf("Ir"));
      const ir = Number(fields[column + 1] ?? 0);
      counts.set(current, (counts.get(current) ?? 0) + ir);
    }
  }
  return counts;
}

/** Per-function instruction-count deltas, largest absolute first. */
export function compareCounts(baseline, candidate) {
  const names = new Set([...baseline.keys(), ...candidate.keys()]);
  const deltas = [];
  let totalBaseline = 0;
  let totalCandidate = 0;
  for (const name of names) {
    const a = baseline.get(name) ?? 0;
    const b = candidate.get(name) ?? 0;
    totalBaseline += a;
    totalCandidate += b;
    if (a !== b) deltas.push({ name, baseline: a, candidate: b, delta: b - a });
  }
  deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || (x.name < y.name ? -1 : 1));
  return {
    identical: deltas.length === 0,
    total: { baseline: totalBaseline, candidate: totalCandidate },
    deltas,
  };
}

/* ── runtime packs ─────────────────────────────────────────────────────── */

/** Every file a runtime-pack.json lists (each flavor's runtime unit
 * variants, their bitcode, and the vendor archives), as path → sha256. */
export function runtimePackFiles(manifest) {
  const files = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      if (typeof value.path === "string" && typeof value.sha256 === "string")
        files.set(value.path, value.sha256);
      Object.values(value).forEach(visit);
    }
  };
  visit(manifest.flavors ?? {});
  visit(manifest.archives ?? {});
  return files;
}

/** The runtime pack files that differ between two runtime-pack.json
 * manifests: changed, added and removed paths, each sorted. */
export function runtimePackDiff(baseline, candidate) {
  const before = runtimePackFiles(baseline);
  const after = runtimePackFiles(candidate);
  const changed = [...before].filter(([path, sha]) => after.has(path) && after.get(path) !== sha);
  return {
    changed: changed.map(([path]) => path).sort(),
    added: [...after.keys()].filter((path) => !before.has(path)).sort(),
    removed: [...before.keys()].filter((path) => !after.has(path)).sort(),
  };
}

/** The changed runtime pack files whose symbols executables link: runtime
 * objects and vendor archives. */
export function linkedRuntimeFiles(diff) {
  return [...diff.changed, ...diff.added, ...diff.removed].filter(
    (path) => path.endsWith(".o") || path.endsWith(".a"),
  );
}

/** Defined functions of textual LLVM IR (llvm-dis output) as name → hash of
 * the body. Attribute group and metadata numbers are dropped first, since
 * an unrelated change elsewhere in the unit renumbers them. */
export function llvmFunctionHashes(text) {
  const functions = new Map();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const head = /^define\b[^@]*@("(?:[^"\\]|\\.)*"|[\w.$-]+)\(/.exec(lines[index]);
    if (head === null) continue;
    const body = [];
    for (; index < lines.length && lines[index] !== "}"; index++) body.push(lines[index]);
    const normalized = body.join("\n").replace(/ #\d+/g, "").replace(/!\d+/g, "!");
    functions.set(head[1].replace(/^"|"$/g, ""), hash(normalized));
  }
  return functions;
}

/** Names whose hashes differ between two function maps, and the names only
 * one side defines. */
export function changedFunctions(before, after) {
  return {
    changed: [...before]
      .filter(([name, h]) => after.has(name) && after.get(name) !== h)
      .map(([name]) => name)
      .sort(),
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
  };
}

/** Whether every symbol an executable comparison added, removed or resized
 * is one of `runtimeSymbols`, the symbols the changed runtime objects
 * define. Mach-O nm prints no sizes, so there only additions and removals
 * are checked. */
export function confinedToRuntime(exe, runtimeSymbols) {
  return [...exe.added, ...exe.removed, ...exe.resized.map((s) => s.name)].every((name) =>
    runtimeSymbols.has(name),
  );
}

/** The report lines the gate prints for one program. */
export function programLines(entry) {
  const lines = [];
  const pct = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}%`;
  const label = {
    identical: "identical",
    allowed: "allowed  ",
    differs: "DIFFERS  ",
    "runtime-only": "runtime  ",
    nondeterministic: "nondet   ",
    "build-error": "ERROR    ",
    "both-fail": "both-fail",
  }[entry.verdict];
  const notes = [];
  for (const [kind, result] of Object.entries(entry.artifacts))
    if (!result.identical) {
      const counts = result.changed
        ? ` (${result.changed.length} changed, ${result.added.length} added, ${result.removed.length} removed)`
        : "";
      notes.push(`${kind}: ${result.first}${counts}`);
    }
  const size = entry.artifacts.exe?.bytes;
  if (size && size.baseline !== size.candidate)
    notes.push(
      `size ${size.baseline} -> ${size.candidate} B (${pct(size.candidate / size.baseline)})`,
    );
  if (entry.cachegrind?.total) {
    const { total, deltas } = entry.cachegrind;
    notes.push(
      `Ir ${total.baseline} -> ${total.candidate} (${pct(total.candidate / Math.max(1, total.baseline))})` +
        (deltas[0]
          ? `, largest ${deltas[0].name} ${deltas[0].delta > 0 ? "+" : ""}${deltas[0].delta}`
          : ""),
    );
  } else if (entry.cachegrind?.skipped)
    notes.push(`cachegrind skipped: ${entry.cachegrind.skipped}`);
  if (entry.runtime) {
    const linked = [...entry.runtime.changed, ...entry.runtime.added];
    notes.push(
      `runtime-only: links ${linked.length} changed runtime function${linked.length === 1 ? "" : "s"}` +
        (linked.length
          ? ` (${linked.slice(0, 8).join(", ")}${linked.length > 8 ? ", ..." : ""})`
          : ""),
    );
  }
  if (entry.nondeterministic)
    notes.push(`the baseline's own rebuild differs in ${entry.nondeterministic.join(", ")}`);
  for (const failure of entry.dynamicTier?.failures ?? []) notes.push(`SYMBOLS: ${failure}`);
  lines.push(`${label}  ${entry.id}${notes.length ? `  ${notes.join("; ")}` : ""}`);
  // A build error's first line is often a warning; print all of it.
  const errors =
    entry.baselineError !== undefined && entry.baselineError === entry.candidateError
      ? [["baseline and candidate", entry.baselineError]]
      : [
          ["baseline", entry.baselineError],
          ["candidate", entry.candidateError],
        ].filter(([, error]) => error !== undefined);
  for (const [side, error] of errors) {
    lines.push(`           ${side}:`);
    for (const line of error.split("\n")) lines.push(`             ${line}`);
  }
  return lines;
}

/* ── verdicts ──────────────────────────────────────────────────────────── */

/** One program's verdict from its build results and artifact comparisons.
 * `allowed` marks programs that match the change's pattern signature. */
/** `required` programs must build with both checkouts: a failure both share
 * means the gate compared nothing for them. Other programs may fail the same
 * way on both sides, as a corpus program the compiler refuses does. */
/** A difference in the release executable alone, with identical IR and
 * LLVM, is "runtime-only" when `runtimeOnly` says the changed runtime
 * objects explain it (the gate checks the runtime packs and the symbols).
 * A difference the baseline also shows when it builds the program again is
 * "nondeterministic": `nondeterministic` lists the artifact kinds whose
 * baseline rebuild differs, and every differing artifact must be among
 * them. Neither fails the gate unless `strict` is set. */
export function programVerdict({
  baseline,
  candidate,
  artifacts,
  allowed,
  required = false,
  runtimeOnly = false,
  nondeterministic = [],
  strict = false,
}) {
  if (!baseline.ok || !candidate.ok) {
    if (!baseline.ok && !candidate.ok && baseline.error === candidate.error)
      return { verdict: "both-fail", fails: required };
    return { verdict: "build-error", fails: true };
  }
  const differing = Object.entries(artifacts).filter(([, r]) => !r.identical);
  if (differing.length === 0) return { verdict: "identical", fails: false };
  if (allowed) return { verdict: "allowed", fails: false };
  if (runtimeOnly && differing.every(([kind]) => kind === "exe"))
    return { verdict: "runtime-only", fails: strict };
  if (differing.every(([kind]) => nondeterministic.includes(kind)))
    return { verdict: "nondeterministic", fails: strict };
  return { verdict: "differs", fails: true };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function geomean(values) {
  return values.length === 0
    ? 1
    : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}

/** Compile-time ratio (candidate / baseline) for a set of programs. Each
 * row holds paired samples: one baseline and one candidate build that ran
 * side by side, so both saw the same machine load. The estimate is the
 * geometric mean of each program's median pair ratio, with a 95% bootstrap
 * interval over the pairs. Builds on a shared VM vary by 10-20% run to run,
 * so the gate judges the interval, not the point estimate. */
export function timeRatio(rows, resamples = 2000) {
  let state = 0x5eed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pick = (xs) =>
    Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)]);
  const estimate = (draw) => geomean(rows.map((r) => median(draw(r.ratios))));
  const ratios = Array.from({ length: resamples }, () => estimate(pick)).sort((a, b) => a - b);
  return {
    ratio: estimate((xs) => xs),
    low: ratios[Math.floor(resamples * 0.025)],
    high: ratios[Math.floor(resamples * 0.975)],
  };
}

/** The compile-time verdict for one group of timing rows (`bench` or
 * `self`): it fails when the 95% interval lies entirely above the allowed
 * growth, and is inconclusive when the interval straddles it. */
export function timingVerdict(name, rows, maxGrowth) {
  const result = timeRatio(rows);
  const fails = result.low > 1 + maxGrowth;
  const verdict = fails
    ? "SLOWER"
    : result.high > 1 + maxGrowth
      ? "inconclusive (rerun with more runs)"
      : "within tolerance";
  const pct = (ratio) => `${ratio >= 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(2)}%`;
  return {
    result,
    fails,
    line:
      `time       ${name} ${rows.length > 1 ? "geomean " : ""}${pct(result.ratio)} ` +
      `[95% CI ${pct(result.low)}, ${pct(result.high)}]: ${verdict}`,
    failure: fails
      ? `${name} compile time grew ${pct(result.ratio)} (CI low ${pct(result.low)})`
      : null,
  };
}

/** Timing rows grouped as the gate judges them. */
export function timingGroups(rows) {
  return {
    bench: rows.filter((r) => r.id.startsWith("bench/")),
    self: rows.filter((r) => r.id === "self/cli"),
  };
}

/* ── baseline cache ────────────────────────────────────────────────────── */

/** A content hash of one artifact file, as the baseline cache records it. */
export const artifactHash = hash;

/** The hash of what a program's build reads, as the baseline cache records
 * it: `files` (the entry and its relative imports) by path relative to
 * `root` and content, read through `read`, and the optimization level. */
export function programInputsHash(root, files, optimization, read) {
  const h = createHash("sha1").update(`${optimization}\0`);
  for (const file of [...files].sort())
    h.update(`${file.startsWith(root + "/") ? file.slice(root.length + 1) : file}\0`)
      .update(read(file))
      .update("\0");
  return h.digest("hex");
}

/** The baseline cache entry recorded for program `id`, or undefined when the
 * cache has none or recorded it for other inputs (`programInputsHash`): a
 * program or an import that changed since the record must build its
 * baseline, or a recorded build error or artifact hash of the old sources
 * would settle the new sources' comparison. */
export function recordedBaseline(cache, id, inputs) {
  const entry = cache?.programs[id];
  return entry !== undefined && entry.inputs === inputs ? entry : undefined;
}

/** The comparison a cached baseline entry settles without building the
 * baseline, or null when the baseline must be built: identical artifacts
 * (every recorded hash equals the candidate's) or the same build error on
 * both sides. `candidate` holds the candidate's build result and `hashes`
 * its artifact hashes. */
export function cachedComparison(entry, candidate, hashes) {
  if (entry === undefined) return null;
  if (!entry.ok || !candidate.ok)
    return !entry.ok && !candidate.ok && entry.error === candidate.error
      ? {
          baseline: { ok: false, error: entry.error, ms: entry.ms ?? null, cached: true },
          artifacts: {},
        }
      : null;
  const kinds = Object.keys(entry.hashes);
  const differs = (kind) => entry.hashes[kind] === null || entry.hashes[kind] !== hashes[kind];
  if (kinds.length === 0 || kinds.some(differs)) return null;
  const artifacts = {};
  for (const kind of kinds) artifacts[kind] = { identical: true };
  if (artifacts.exe) artifacts.exe.bytes = { baseline: entry.exeBytes, candidate: entry.exeBytes };
  return { baseline: { ok: true, ms: entry.ms ?? null }, artifacts };
}

/* ── sharded runs ──────────────────────────────────────────────────────── */

/** Merge the --json reports of gate shards that split one good-code set
 * (--shard, --set) into a single report with one verdict. Program entries
 * and their failures are concatenated; the compile-time groups and the
 * "nothing was compared" check are recomputed over all shards. */
export function mergeReports(reports) {
  assert(reports.length > 0, "no gate reports to merge");
  const [first] = reports;
  for (const report of reports) {
    assert(report.schema === first.schema, "gate reports have different schemas");
    for (const label of ["baseline", "candidate"])
      assert(
        report.trees[label].revision === first.trees[label].revision,
        `gate reports compare different ${label} revisions`,
      );
  }
  const globals = new Set(reports.flatMap((r) => r.globalFailures ?? []));
  const merged = {
    ...first,
    shards: reports.length,
    programs: reports.flatMap((r) => r.programs),
    failures: reports.flatMap((r) => r.failures.filter((f) => !globals.has(f))),
    globalFailures: [],
    timing: null,
    candidateSelf: reports.find((r) => r.candidateSelf)?.candidateSelf,
    elapsedMs: Math.max(...reports.map((r) => r.elapsedMs ?? 0)),
  };
  const ids = new Set();
  for (const p of merged.programs) {
    assert(!ids.has(p.id), `program ${p.id} appears in more than one gate report`);
    ids.add(p.id);
  }
  const timed = reports.filter((r) => r.timing !== null);
  const lines = [];
  if (timed.length > 0) {
    const rows = timed.flatMap((r) => r.timing.rows);
    const maxGrowth = timed[0].timing.maxGrowth;
    merged.timing = { runs: timed[0].timing.runs, maxGrowth, rows, groups: {} };
    for (const [name, group] of Object.entries(timingGroups(rows))) {
      if (group.length === 0) continue;
      const { result, line, failure } = timingVerdict(name, group, maxGrowth);
      merged.timing.groups[name] = result;
      lines.push(line);
      if (failure !== null) merged.globalFailures.push(failure);
    }
  }
  const counts = {};
  for (const p of merged.programs) counts[p.verdict] = (counts[p.verdict] ?? 0) + 1;
  const compared = ["identical", "allowed", "runtime-only", "nondeterministic", "differs"];
  if (!merged.programs.some((p) => compared.includes(p.verdict)))
    merged.globalFailures.push("no program built with both checkouts, so nothing was compared");
  merged.failures.push(...merged.globalFailures);
  merged.counts = counts;
  merged.verdict = merged.failures.length > 0 ? "fail" : "pass";
  return { report: merged, timingLines: lines };
}
