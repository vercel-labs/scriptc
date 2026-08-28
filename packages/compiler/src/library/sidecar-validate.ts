/* The sidecar schema's validation rules (§11, V1–V14) as an emitter
 * self-check and a test-side conformance oracle. Everything checkable
 * from the document alone is checked here; the rules needing external
 * facts stay with their owners and are exercised by the harness instead:
 * V11's symbol comparison (nm over the archive), V12's getter comparison
 * (the probe prints the exported u64), V13's byte-identical re-run (two
 * independent compiles), V14's attestation honesty (the emitter computes
 * both attestations from the module graph; this module cannot re-derive
 * them from the document).
 *
 * The checks key on the RULES, never on any example's specific field
 * lists — the schema's worked example is illustrative and its record
 * shapes may drift; a conforming document of any shape passes. */

type Dict = Record<string, unknown>;

const TOP_LEVEL_ORDER = [
  "format",
  "wire_version",
  "abi_version",
  "compiler_version",
  "entry",
  "source_hash",
  "build_id",
  "types",
  "model",
  "model_helpers",
  "model_unbound",
  "msg",
  "init_returns_cmd",
  "update_returns_cmd",
  "has_subscriptions",
  "channels",
  "abi",
  "integer_slots",
  "deterministic",
  "async_free",
] as const;

const HASH_RE = /^[0-9a-f]{16}$/;
const TYPEREF_KINDS = new Set(["bool", "f64", "i64", "bytes", "void", "optional", "slice", "node", "value", "enum", "union"]);
const FUNCTION_CHANNELS = ["command_msg", "frame_msg", "key_msg", "pinch_msg"] as const;

function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate a parsed sidecar document against the doc-internal halves of
 * V1–V10 (plus V11's shape checks). Returns rule-tagged violation
 * messages; empty = conforming. */
export function validateSidecar(doc: unknown): string[] {
  const out: string[] = [];
  const bad = (rule: string, msg: string): void => {
    out.push(`${rule}: ${msg}`);
  };
  if (!isDict(doc)) return ["V1: the sidecar is not a JSON object"];

  /* ── V1: required fields, format, top-level key order ─────────────── */
  const keys = Object.keys(doc);
  for (const k of TOP_LEVEL_ORDER) {
    if (!(k in doc)) bad("V1", `required field '${k}' is missing`);
  }
  for (const k of keys) {
    if (!(TOP_LEVEL_ORDER as readonly string[]).includes(k)) bad("V1", `unknown top-level field '${k}' (emit only format-1 fields)`);
  }
  const present = TOP_LEVEL_ORDER.filter((k) => k in doc);
  const actual = keys.filter((k) => (TOP_LEVEL_ORDER as readonly string[]).includes(k));
  if (present.join(",") !== actual.join(",")) {
    bad("V1", "top-level keys are not emitted in the schema's §1 order");
  }
  if (doc["format"] !== 1) bad("V1", `format must be 1, found ${JSON.stringify(doc["format"])}`);
  for (const k of ["wire_version", "abi_version"]) {
    if (typeof doc[k] !== "number" || !Number.isInteger(doc[k])) bad("V1", `'${k}' must be an integer`);
  }
  for (const k of ["compiler_version", "entry", "model"]) {
    if (typeof doc[k] !== "string" || doc[k] === "") bad("V1", `'${k}' must be a non-empty string`);
  }
  for (const k of ["init_returns_cmd", "update_returns_cmd", "has_subscriptions", "deterministic", "async_free"]) {
    if (typeof doc[k] !== "boolean") bad("V1", `'${k}' must be a boolean`);
  }
  if (typeof doc["entry"] === "string" && (doc["entry"].includes("\\") || doc["entry"].startsWith("/"))) {
    bad("V1", "'entry' must be a compilation-root-relative POSIX path");
  }

  /* ── V2: hash encodings ───────────────────────────────────────────── */
  for (const k of ["source_hash", "build_id"]) {
    if (typeof doc[k] !== "string" || !HASH_RE.test(doc[k])) {
      bad("V2", `'${k}' must be exactly 16 lowercase hex digits`);
    }
  }

  /* ── the type table (shape first — later rules walk it) ───────────── */
  const types = doc["types"];
  if (!isDict(types) || !Array.isArray(types["structs"]) || !Array.isArray(types["enums"]) || !Array.isArray(types["unions"])) {
    bad("V1", "'types' must carry the three arrays structs/enums/unions");
    return out;
  }
  const structs = new Map<string, Dict>();
  const enums = new Map<string, Dict>();
  const unions = new Map<string, Dict>();
  const claimName = (name: unknown, where: string): string | null => {
    if (typeof name !== "string" || name === "") {
      bad("V1", `${where} entry has no name`);
      return null;
    }
    if (structs.has(name) || enums.has(name) || unions.has(name)) {
      bad("V3", `type name '${name}' appears twice — structs, enums, and unions share one namespace`);
      return null;
    }
    return name;
  };
  for (const s of types["structs"] as unknown[]) {
    if (!isDict(s)) continue;
    const name = claimName(s["name"], "structs");
    if (name !== null) structs.set(name, s);
  }
  for (const e of types["enums"] as unknown[]) {
    if (!isDict(e)) continue;
    const name = claimName(e["name"], "enums");
    if (name !== null) enums.set(name, e);
  }
  for (const u of types["unions"] as unknown[]) {
    if (!isDict(u)) continue;
    const name = claimName(u["name"], "unions");
    if (name !== null) unions.set(name, u);
  }

  /* ── V4/V7 walkers: TypeRef structure + reference resolution ──────── */
  const reachable = new Set<string>();
  const edges = new Map<string, Set<string>>(); // for V5
  const i64Slots: string[] = []; // for V10 (slice elements exempt)

  const walkRef = (ref: unknown, where: string, owner: string | null, slotPath: string | null): void => {
    if (!isDict(ref) || typeof ref["kind"] !== "string") {
      bad("V4", `${where} is not a TypeRef object`);
      return;
    }
    const kind = ref["kind"];
    if (!TYPEREF_KINDS.has(kind)) {
      bad("V4", `${where} carries unknown TypeRef kind '${kind}'`);
      return;
    }
    switch (kind) {
      case "i64":
        if (slotPath !== null) i64Slots.push(slotPath);
        return;
      case "optional":
        walkRef(ref["inner"], `${where}.inner`, owner, slotPath);
        return;
      case "slice":
        // Slice elements are exempt from the V10 bijection: the format-1
        // slot grammar has no slice-element form (§9 clarification).
        walkRef(ref["elem"], `${where}.elem`, owner, null);
        return;
      case "node":
      case "value":
      case "enum":
      case "union": {
        const name = ref["name"];
        if (typeof name !== "string") {
          bad("V4", `${where} names no type`);
          return;
        }
        const table = kind === "enum" ? enums : kind === "union" ? unions : structs;
        if (!table.has(name)) {
          bad("V4", `${where} references '${name}', which is not a ${kind === "node" || kind === "value" ? "struct" : kind} in the type table`);
          return;
        }
        reachable.add(name);
        if (owner !== null) {
          let set = edges.get(owner);
          if (set === undefined) {
            set = new Set();
            edges.set(owner, set);
          }
          set.add(name);
        }
        return;
      }
      default:
        return;
    }
  };

  /* ── V3 (inner uniqueness) + table entry shapes ───────────────────── */
  for (const [name, s] of structs) {
    // Format 1 marks compiler-created anonymous inline records with the
    // optional literal `synthesized: true`; source-declared records omit it.
    if ("synthesized" in s && s["synthesized"] !== true) {
      bad("V1", `struct '${name}' has a synthesized marker other than literal true`);
    }
    const fields = s["fields"];
    if (!Array.isArray(fields)) {
      bad("V1", `struct '${name}' has no fields array`);
      continue;
    }
    const seen = new Set<string>();
    for (const f of fields as unknown[]) {
      if (!isDict(f) || typeof f["name"] !== "string") {
        bad("V1", `struct '${name}' carries a malformed field`);
        continue;
      }
      if (seen.has(f["name"])) bad("V3", `struct '${name}' repeats field '${f["name"]}'`);
      seen.add(f["name"]);
      walkRef(f["type"], `struct '${name}' field '${f["name"]}'`, name, `${name}.${f["name"]}`);
    }
  }
  for (const [name, e] of enums) {
    const members = e["members"];
    if (!Array.isArray(members) || members.some((m) => typeof m !== "string")) {
      bad("V1", `enum '${name}' has no string member array`);
      continue;
    }
    if (new Set(members as string[]).size !== members.length) bad("V3", `enum '${name}' repeats a member`);
  }
  for (const [name, u] of unions) {
    const arms = u["arms"];
    if (!Array.isArray(arms)) {
      bad("V1", `union '${name}' has no arms array`);
      continue;
    }
    const seen = new Set<string>();
    for (const a of arms as unknown[]) {
      if (!isDict(a) || typeof a["name"] !== "string") {
        bad("V1", `union '${name}' carries a malformed arm`);
        continue;
      }
      if (seen.has(a["name"])) bad("V3", `union '${name}' repeats arm '${a["name"]}'`);
      seen.add(a["name"]);
      walkRef(a["payload"], `union '${name}' arm '${a["name"]}'`, name, `${name}.${a["name"]}`);
    }
  }

  /* ── model / helpers / msg ────────────────────────────────────────── */
  const model = doc["model"];
  const modelFields = new Set<string>();
  if (typeof model === "string") {
    const entry = structs.get(model);
    if (entry === undefined) {
      bad("V4", `'model' names '${model}', which is not a struct in the type table`);
    } else {
      reachable.add(model);
      for (const f of (entry["fields"] as unknown[] | undefined) ?? []) {
        if (isDict(f) && typeof f["name"] === "string") modelFields.add(f["name"]);
      }
    }
  }

  const helpers = doc["model_helpers"];
  const helperNames = new Set<string>();
  if (!Array.isArray(helpers)) {
    bad("V1", "'model_helpers' must be an array");
  } else {
    helpers.forEach((h, i) => {
      if (!isDict(h) || typeof h["name"] !== "string" || typeof h["arena"] !== "boolean" || !Array.isArray(h["params"])) {
        bad("V1", `model_helpers[${i}] is malformed (name/params/returns/arena)`);
        return;
      }
      const name = h["name"];
      if (helperNames.has(name)) bad("V3", `helper '${name}' appears twice`);
      helperNames.add(name);
      (h["params"] as unknown[]).forEach((p, j) => {
        walkRef(p, `helper '${name}' params[${j}]`, null, `helpers.${name}.params[${j}]`);
      });
      walkRef(h["returns"], `helper '${name}' returns`, null, `helpers.${name}.return`);
    });
  }

  const msg = doc["msg"];
  const armDescriptors = new Map<string, Dict>();
  let msgName = "Msg";
  if (!isDict(msg) || typeof msg["name"] !== "string" || !Array.isArray(msg["arms"]) || !Array.isArray(msg["unbound"])) {
    bad("V1", "'msg' must carry name, arms, and unbound");
  } else {
    msgName = msg["name"];
    const arms = msg["arms"] as unknown[];
    if (arms.length > 256) bad("V6", `msg declares ${arms.length} arms — tags ride a u8, so at most 256 are permitted`);
    for (const a of arms) {
      if (!isDict(a) || typeof a["name"] !== "string" || !isDict(a["payload"])) {
        bad("V1", "msg carries a malformed arm");
        continue;
      }
      const armName = a["name"];
      if (armDescriptors.has(armName)) bad("V3", `msg repeats arm '${armName}'`);
      const d = a["payload"] as Dict;
      armDescriptors.set(armName, d);
      switch (d["kind"]) {
        case "void":
        case "bytes":
          break;
        case "number":
          if (d["class"] !== "f64" && d["class"] !== "i64") {
            bad("V7", `msg arm '${armName}': number class must be "f64" or "i64"`);
          } else if (d["class"] === "i64") {
            i64Slots.push(`${msgName}.${armName}`);
          }
          break;
        case "number_bytes": {
          const nf = d["number_field"];
          const bf = d["bytes_field"];
          if (typeof nf !== "string" || typeof bf !== "string" || nf === "" || bf === "" || nf === bf) {
            bad("V7", `msg arm '${armName}': number_bytes needs distinct, non-empty number_field and bytes_field`);
          }
          if (d["number_class"] !== "f64" && d["number_class"] !== "i64") {
            bad("V7", `msg arm '${armName}': number_bytes class must be "f64" or "i64"`);
          } else if (d["number_class"] === "i64" && typeof nf === "string") {
            i64Slots.push(`${msgName}.${armName}.${nf}`);
          }
          break;
        }
        case "record":
        case "union":
        case "enum": {
          const name = d["name"];
          const table = d["kind"] === "record" ? structs : d["kind"] === "union" ? unions : enums;
          if (typeof name !== "string" || !table.has(name)) {
            bad("V4", `msg arm '${armName}': ${String(d["kind"])} payload does not resolve to a matching table entry`);
          } else {
            reachable.add(name);
          }
          break;
        }
        case "scalar": {
          const t = d["type"];
          // Scalar optionals can carry the msg arm's integer-classed number
          // slot (optional<i64>); slices still clear the path in walkRef
          // because format 1 has no slice-element slot grammar.
          walkRef(t, `msg arm '${armName}' scalar payload`, null, `${msgName}.${armName}`);
          if (isDict(t) && (t["kind"] === "node" || t["kind"] === "value" || t["kind"] === "void")) {
            bad("V7", `msg arm '${armName}': scalar descriptors carry a non-record, non-void TypeRef`);
          }
          break;
        }
        default:
          bad("V7", `msg arm '${armName}' carries unknown payload descriptor kind '${String(d["kind"])}'`);
      }
    }
  }

  /* ── V5: acyclicity of the named-reference graph ──────────────────── */
  {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        bad("V5", `the type reference graph is cyclic: ${[...path, name].join(" -> ")}`);
        return;
      }
      visiting.add(name);
      for (const next of edges.get(name) ?? []) visit(next, [...path, name]);
      visiting.delete(name);
      done.add(name);
    };
    for (const name of edges.keys()) visit(name, []);
  }

  /* ── V8: unbound lists ────────────────────────────────────────────── */
  const modelUnbound = doc["model_unbound"];
  if (!Array.isArray(modelUnbound) || modelUnbound.some((x) => typeof x !== "string")) {
    bad("V1", "'model_unbound' must be an array of strings");
  } else {
    for (const name of modelUnbound as string[]) {
      if (!modelFields.has(name) && !helperNames.has(name)) {
        bad("V8", `model_unbound names '${name}', which is neither a model field nor a helper entry`);
      }
    }
  }
  if (isDict(msg) && Array.isArray(msg["unbound"])) {
    for (const name of msg["unbound"] as unknown[]) {
      if (typeof name !== "string" || !armDescriptors.has(name)) {
        bad("V8", `msg.unbound names '${String(name)}', which is not an arm of msg`);
      }
    }
  }

  /* ── abi shape (V11's document half) ──────────────────────────────── */
  const abi = doc["abi"];
  const exportSet = new Set<string>();
  if (!isDict(abi) || typeof abi["prefix"] !== "string" || !Array.isArray(abi["exports"]) || typeof abi["snapshot_format"] !== "number") {
    bad("V1", "'abi' must carry prefix, exports, and snapshot_format");
  } else {
    for (const s of abi["exports"] as unknown[]) {
      if (typeof s !== "string" || s === "") {
        bad("V11", "abi.exports carries a non-string suffix");
        continue;
      }
      if (exportSet.has(s)) bad("V11", `abi.exports repeats suffix '${s}'`);
      exportSet.add(s);
    }
  }

  /* ── V9: channel wiring ───────────────────────────────────────────── */
  const channels = doc["channels"];
  if (!isDict(channels)) {
    bad("V1", "'channels' must be an object");
  } else {
    for (const ch of FUNCTION_CHANNELS) {
      const v = channels[ch];
      if (typeof v !== "boolean") {
        bad("V1", `channels.${ch} must be a boolean`);
        continue;
      }
      if (v !== exportSet.has(ch)) {
        bad("V9", `channels.${ch} is ${v} but the suffix '${ch}' is ${v ? "absent from" : "present in"} abi.exports`);
      }
    }
    for (const ch of ["appearance_msg", "chrome_msg"] as const) {
      const v = channels[ch];
      if (v === null) continue;
      if (typeof v !== "string") {
        bad("V1", `channels.${ch} must be null or an arm name`);
        continue;
      }
      const d = armDescriptors.get(v);
      if (d === undefined) {
        bad("V9", `channels.${ch} names '${v}', which is not an arm of msg`);
      } else if (d["kind"] !== "record" && d["kind"] !== "union" && d["kind"] !== "enum" && d["kind"] !== "scalar") {
        bad("V9", `channels.${ch} names arm '${v}', whose descriptor is not of the named-type family`);
      }
    }
    const envMsgs = channels["env_msgs"];
    if (!Array.isArray(envMsgs)) {
      bad("V1", "channels.env_msgs must be an array");
    } else {
      const seenEnv = new Set<string>();
      for (const e of envMsgs as unknown[]) {
        if (!isDict(e) || typeof e["env"] !== "string" || typeof e["msg"] !== "string") {
          bad("V1", "channels.env_msgs carries a malformed entry");
          continue;
        }
        if (seenEnv.has(e["env"])) bad("V9", `channels.env_msgs repeats environment variable '${e["env"]}'`);
        seenEnv.add(e["env"]);
        const d = armDescriptors.get(e["msg"]);
        if (d === undefined) {
          bad("V9", `channels.env_msgs targets '${e["msg"]}', which is not an arm of msg`);
        } else if (d["kind"] !== "bytes") {
          bad("V9", `channels.env_msgs targets arm '${e["msg"]}', whose descriptor is not {"kind": "bytes"}`);
        }
      }
    }
  }

  /* ── V4's exactness: no table entry unreachable ───────────────────── */
  {
    // Close reachability over the edges (walkRef marked direct hits and
    // recorded owner edges; entries reached only through other entries
    // close here).
    let grew = true;
    while (grew) {
      grew = false;
      for (const name of [...reachable]) {
        for (const next of edges.get(name) ?? []) {
          if (!reachable.has(next)) {
            reachable.add(next);
            grew = true;
          }
        }
      }
    }
    for (const name of [...structs.keys(), ...enums.keys(), ...unions.keys()]) {
      if (!reachable.has(name)) {
        bad("V4", `table entry '${name}' is unreachable from model, msg, model_helpers, and channels`);
      }
    }
  }

  /* ── V10: the integer-slot bijection (slice elements exempt) ──────── */
  const integerSlots = doc["integer_slots"];
  if (!Array.isArray(integerSlots)) {
    bad("V1", "'integer_slots' must be an array (empty when no slot is integer-classed)");
  } else {
    const declared = new Set<string>();
    for (const e of integerSlots as unknown[]) {
      if (!isDict(e) || typeof e["slot"] !== "string" || (e["class"] !== "i64" && e["class"] !== "u64")) {
        bad("V1", "integer_slots carries a malformed entry");
        continue;
      }
      if (declared.has(e["slot"])) bad("V10", `integer_slots repeats slot '${e["slot"]}'`);
      declared.add(e["slot"]);
    }
    const spelled = new Set(i64Slots);
    for (const slot of spelled) {
      if (!declared.has(slot)) bad("V10", `'${slot}' is spelled i64 but has no integer_slots entry`);
    }
    for (const slot of declared) {
      if (!spelled.has(slot)) bad("V10", `integer_slots entry '${slot}' resolves to no slot spelled i64`);
    }
  }

  return out;
}
