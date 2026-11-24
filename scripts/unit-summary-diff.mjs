#!/usr/bin/env node
/* The M0 leak report: given two summaries of one unit from two apps, list
 * everything that differs between them. This is the measurement M0 exists
 * for — how much of a package's lowering facts (and today's class numbering)
 * changes from one app to another — and it sizes the FACT-AUDIT slices.
 *
 *   node scripts/unit-summary-diff.mjs a/summary.json b/summary.json [--json]
 *   node scripts/unit-summary-diff.mjs --a <dir-or-file> --b <dir-or-file>
 *   node scripts/unit-summary-diff.mjs --keys a/meta.json b/meta.json
 *
 * A directory argument reads its `summary.json`. The diff covers:
 *   - every declaration whose `facts` differ (or exists on one side only),
 *   - every class whose id or vtable slots differ,
 *   - every generic whose demanded instance set differs,
 *   - the `facts` table's values.
 * Results are grouped by module; `--json` prints the machine-readable form
 * the REPORT's numbers come from.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    json: { type: "boolean", default: false },
    keys: { type: "boolean", default: false },
    "top": { type: "string", default: "20" },
  },
  allowPositionals: true,
});

function summaryPath(value) {
  const stat = statSync(value);
  return stat.isDirectory() ? join(value, "summary.json") : value;
}

const aPath = values.a ?? positionals[0];
const bPath = values.b ?? positionals[1];
if (aPath === undefined || bPath === undefined) {
  console.error(
    "usage: node scripts/unit-summary-diff.mjs <a/summary.json> <b/summary.json> [--json]",
  );
  process.exit(2);
}
if (values.keys) {
  // meta.json entries: the same unit id's key fields side by side, so a key
  // that differs for two apps says which input differs (M0's key diagnosis).
  const a = JSON.parse(readFileSync(aPath, "utf8"));
  const b = JSON.parse(readFileSync(bPath, "utf8"));
  const parts = [
    ...new Set([...Object.keys(a.keyParts ?? {}), ...Object.keys(b.keyParts ?? {})]),
  ].sort();
  console.log(`unit ${a.unit?.id} vs ${b.unit?.id}`);
  console.log(`key ${a.key?.slice(0, 12)} vs ${b.key?.slice(0, 12)}`);
  for (const part of parts) {
    const av = a.keyParts?.[part] ?? "absent";
    const bv = b.keyParts?.[part] ?? "absent";
    console.log(`  ${part}: ${av === bv ? "same" : `${av.slice(0, 12)} -> ${bv.slice(0, 12)}`}`);
  }
  console.log(
    `summary digest: ${a.summaryDigest === b.summaryDigest ? "same" : `${a.summaryDigest?.slice(0, 12)} -> ${b.summaryDigest?.slice(0, 12)}`}`,
  );
  process.exit(0);
}
const a = JSON.parse(readFileSync(summaryPath(aPath), "utf8"));
const b = JSON.parse(readFileSync(summaryPath(bPath), "utf8"));
if (a.schema !== "scriptc.unit-summary.v0" || b.schema !== "scriptc.unit-summary.v0") {
  console.error("not scriptc.unit-summary.v0 summaries");
  process.exit(2);
}
const top = Number(values.top);
const topN = Number.isFinite(top) && top > 0 ? top : 20;

const keyOf = (...parts) => parts.join("\0");
/** Map a list by a key, remembering duplicate keys (two declarations of one
 * name in one module). */
function index(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = key(item);
    const list = map.get(k);
    if (list === undefined) map.set(k, [item]);
    else list.push(item);
  }
  return map;
}

const declarations = [];
const aDecls = index(a.declarations ?? [], (d) => keyOf(d.module, d.name, d.kind));
const bDecls = index(b.declarations ?? [], (d) => keyOf(d.module, d.name, d.kind));
for (const [key, listA] of aDecls) {
  const listB = bDecls.get(key) ?? [];
  for (let i = 0; i < Math.max(listA.length, listB.length); i++) {
    const da = listA[i];
    const db = listB[i];
    if (da === undefined || db === undefined || da.facts !== db.facts) {
      declarations.push({
        module: da?.module ?? db?.module ?? "",
        name: da?.name ?? db?.name ?? "",
        kind: da?.kind ?? db?.kind ?? "",
        a: da?.facts ?? null,
        b: db?.facts ?? null,
      });
    }
  }
}
for (const [key, listB] of bDecls) {
  if (aDecls.has(key)) continue;
  for (const db of listB) {
    declarations.push({ module: db.module, name: db.name, kind: db.kind, a: null, b: db.facts });
  }
}

const classes = [];
const aClasses = index(a.classes ?? [], (c) => keyOf(c.module, c.name));
const bClasses = index(b.classes ?? [], (c) => keyOf(c.module, c.name));
for (const [key, listA] of aClasses) {
  const listB = bClasses.get(key) ?? [];
  for (let i = 0; i < Math.max(listA.length, listB.length); i++) {
    const ca = listA[i];
    const cb = listB[i];
    const sameSlots =
      ca !== undefined && cb !== undefined && JSON.stringify(ca.slots) === JSON.stringify(cb.slots);
    if (ca === undefined || cb === undefined || ca.id !== cb.id || !sameSlots) {
      classes.push({
        module: ca?.module ?? cb?.module ?? "",
        name: ca?.name ?? cb?.name ?? "",
        a: ca === undefined ? null : { id: ca.id, slots: ca.slots },
        b: cb === undefined ? null : { id: cb.id, slots: cb.slots },
      });
    }
  }
}
for (const [key, listB] of bClasses) {
  if (aClasses.has(key)) continue;
  for (const cb of listB)
    classes.push({ module: cb.module, name: cb.name, a: null, b: { id: cb.id, slots: cb.slots } });
}

function genericList(summary) {
  const out = [];
  for (const fn of summary.generics?.functions ?? [])
    out.push({ kind: "function", module: fn.module, name: fn.name, demanded: fn.demanded ?? [] });
  for (const cls of summary.generics?.classes ?? [])
    out.push({ kind: "class", module: cls.module, name: cls.name, demanded: cls.demanded ?? [] });
  return out;
}
const generics = [];
const aGenerics = index(genericList(a), (g) => keyOf(g.kind, g.module, g.name));
const bGenerics = index(genericList(b), (g) => keyOf(g.kind, g.module, g.name));
const instances = (list) => [...new Set(list.map((d) => d.instance))].sort();
for (const [key, listA] of aGenerics) {
  const listB = bGenerics.get(key) ?? [];
  for (let i = 0; i < Math.max(listA.length, listB.length); i++) {
    const ga = listA[i];
    const gb = listB[i];
    const setA = JSON.stringify(instances(ga?.demanded ?? []));
    const setB = JSON.stringify(instances(gb?.demanded ?? []));
    if (ga === undefined || gb === undefined || setA !== setB) {
      generics.push({
        module: ga?.module ?? gb?.module ?? "",
        name: ga?.name ?? gb?.name ?? "",
        kind: ga?.kind ?? gb?.kind ?? "",
        a: setA === "[]" && ga === undefined ? null : JSON.parse(setA),
        b: setB === "[]" && gb === undefined ? null : JSON.parse(setB),
      });
    }
  }
}
for (const [key, listB] of bGenerics) {
  if (aGenerics.has(key)) continue;
  for (const gb of listB)
    generics.push({
      module: gb.module,
      name: gb.name,
      kind: gb.kind,
      a: null,
      b: instances(gb.demanded),
    });
}

const runtimeFeaturesDiffer =
  JSON.stringify(a.runtimeFeatures ?? null) !== JSON.stringify(b.runtimeFeatures ?? null);
const facts = [];
for (const name of [
  ...new Set([...Object.keys(a.facts ?? {}), ...Object.keys(b.facts ?? {})]),
].sort()) {
  const fa = a.facts?.[name];
  const fb = b.facts?.[name];
  if (JSON.stringify(fa) !== JSON.stringify(fb)) facts.push({ name, a: fa ?? null, b: fb ?? null });
}

/** Group entries by module, the report's unit of work. */
function byModule(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const list = groups.get(entry.module) ?? [];
    list.push(entry);
    groups.set(entry.module, list);
  }
  return [...groups.entries()]
    .map(([module, list]) => ({ module, count: list.length, entries: list }))
    .sort((x, y) => y.count - x.count || x.module.localeCompare(y.module));
}

const report = {
  a: { unit: a.unit?.id ?? null, files: a.files?.length ?? 0 },
  b: { unit: b.unit?.id ?? null, files: b.files?.length ?? 0 },
  sameUnit: a.unit?.id === b.unit?.id,
  counts: {
    declarations: declarations.length,
    declarationModules: byModule(declarations).length,
    classes: classes.length,
    generics: generics.length,
    facts: facts.length,
    runtimeFeatures: runtimeFeaturesDiffer ? 1 : 0,
  },
  declarations: byModule(declarations),
  classes: byModule(classes),
  generics: byModule(generics),
  facts,
};

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const unit = report.sameUnit ? a.unit.id : `${a.unit?.id} vs ${b.unit?.id}`;
console.log(`unit ${unit}`);
console.log(
  `declarations with differing facts: ${declarations.length} in ${report.counts.declarationModules} modules`,
);
for (const group of report.declarations.slice(0, topN)) {
  console.log(`  ${group.module}: ${group.count}`);
  for (const entry of group.entries.slice(0, topN)) console.log(`    ${entry.kind} ${entry.name}`);
}
console.log(`classes with differing id or slots: ${classes.length}`);
for (const group of report.classes.slice(0, topN)) {
  console.log(`  ${group.module}: ${group.count}`);
  for (const entry of group.entries.slice(0, topN)) {
    const show = (side) =>
      side === null ? "absent" : `id ${side.id} slots [${side.slots.join(", ")}]`;
    console.log(`    ${entry.name}: ${show(entry.a)} -> ${show(entry.b)}`);
  }
}
console.log(`generics with differing demanded instances: ${generics.length}`);
for (const entry of generics.slice(0, topN))
  console.log(
    `  ${entry.kind} ${entry.module} ${entry.name}: [${(entry.a ?? []).join(", ")}] -> [${(entry.b ?? []).join(", ")}]`,
  );
console.log(`runtime features: ${runtimeFeaturesDiffer ? "differ (program-wide field)" : "same"}`);
console.log(`facts whose value differs: ${facts.length}`);
for (const entry of facts.slice(0, topN)) {
  const value = (fact) =>
    fact === null
      ? "absent"
      : `${fact.value}${fact.setByOwnFiles === "unobserved" ? "" : ` (own: ${fact.setByOwnFiles})`}`;
  console.log(`  ${entry.name}: ${value(entry.a)} -> ${value(entry.b)}`);
}
