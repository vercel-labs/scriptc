/* Comparison logic for scripts/zero-cost-gate.mjs, kept free of process
 * orchestration so tests/harness/zero-cost-gate.test.ts can pin it.
 *
 * Artifacts are compared as bytes first. Only when they differ are they split
 * into named units (IR functions, LLVM functions, executable symbols) to name
 * the first unit that differs. The self-hosted compiler's IR and LLVM exceed
 * V8's maximum string length, so splitting works on Buffers and hashes each
 * unit instead of decoding the artifact. */
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
 * node:worker_threads values are dyn objects. bench/dynamic-methods is
 * untyped JavaScript. Every other bench workload is fully typed and must link none. The gate and
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
  "bench/worker-messages",
  "bench/typed-array-scan-workers",
  "bench/log-summary",
  "bench/inventory-report",
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

/* ── verdicts ──────────────────────────────────────────────────────────── */

/** One program's verdict from its build results and artifact comparisons.
 * `allowed` marks programs that match the change's pattern signature. */
/** `required` programs must build with both checkouts: a failure both share
 * means the gate compared nothing for them. Other programs may fail the same
 * way on both sides, as a corpus program the compiler refuses does. */
export function programVerdict({ baseline, candidate, artifacts, allowed, required = false }) {
  if (!baseline.ok || !candidate.ok) {
    if (!baseline.ok && !candidate.ok && baseline.error === candidate.error)
      return { verdict: "both-fail", fails: required };
    return { verdict: "build-error", fails: true };
  }
  const differing = Object.entries(artifacts).filter(([, r]) => !r.identical);
  if (differing.length === 0) return { verdict: "identical", fails: false };
  return allowed ? { verdict: "allowed", fails: false } : { verdict: "differs", fails: true };
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
