#!/usr/bin/env node
// The matrix of unions of record types: one small program per cell, run under Node and as a native
// binary. A cell is (what tells the union's arms apart) x (2 or 3 arms) x (which value) x (how the
// value reaches the union) x (what is done with it). It is the instrument behind the rule in
// packages/compiler/src/frontend/union-classes.ts: a cell must be right or refused at build time.
//
//   node scripts/union-matrix.mjs <compiler-root> <out-dir> [jobs] [filter-regex]
//
// Writes <out-dir>/cells/ (every program), cells.json (both outputs per cell), matrix.tsv and
// summary.txt. Verdicts: ok (stdout and exit code equal), SILENT (native exits like Node with other
// output), TE (native ends with an uncaught TypeError where Node does not; `*` in the table when the
// program asserts or guards a value past its type), ABORT, SEGV, SCnnnn (refused at build time;
// `ts` means TypeScript rejects the cell, which is then no program), ICE (SC9001).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [root, out, jobsArg, filterArg] = process.argv.slice(2);
if (!root || !out) {
  console.error("usage: union-matrix.mjs <compiler-root> <out-dir> [jobs] [filter]");
  process.exit(2);
}
const jobs = Number(jobsArg ?? 28);
const filter = filterArg ? new RegExp(filterArg) : null;
const cli = join(root, "packages/cli/dist/bootstrap.js");
mkdirSync(out, { recursive: true });

// --- kinds -----------------------------------------------------------------
// T is the arm the narrowing ops aim at. `vals`: lit, the declared type of the value before it meets
// the union (vt), whether it is a T (honest for `as T` and the guard), a write through the source.
const kinds = [
  {
    id: "k1-distinct-literal",
    keys: ["kind", "x", "y", "z"],
    other: null,
    arms: ['{ kind: "a"; x: number }', '{ kind: "b"; y: string }', '{ kind: "c"; z: boolean }'],
    T: 1,
    inKey: "y",
    disc: 'v.kind === "b"',
    read: (v) => `${v}.y`,
    write: (v) => `${v}.y = "W"`,
    vals: [
      { id: "one", lit: '{ kind: "b", y: "s" }', vt: "B", isT: true, srcWrite: 'src.y = "Z"' },
      { id: "other", lit: '{ kind: "a", x: 1 }', vt: "A", isT: false, srcWrite: "src.x = 9" },
    ],
  },
  {
    id: "k2-same-literal-subdisc",
    keys: ["kind", "src", "why", "n"],
    other: null,
    arms: [
      '{ kind: "t"; src: "p" }',
      '{ kind: "t"; src: "q"; why: string }',
      '{ kind: "u"; n: number }',
    ],
    T: 1,
    inKey: "why",
    disc: 'v.kind === "t" && v.src === "q"',
    read: (v) => `${v}.why`,
    write: (v) => `${v}.why = "W"`,
    vals: [
      {
        id: "one",
        lit: '{ kind: "t", src: "q", why: "w" }',
        vt: "B",
        isT: true,
        srcWrite: 'src.why = "Z"',
      },
      { id: "other", lit: '{ kind: "t", src: "p" }', vt: "A", isT: false, srcWrite: null },
    ],
  },
  {
    id: "k2n-same-literal-nested",
    keys: ["kind", "id", "parent", "n"],
    other: null,
    arms: [
      '{ kind: "t"; id: string }',
      '{ kind: "t"; id: string; parent: string }',
      '{ kind: "u"; n: number }',
    ],
    T: 1,
    inKey: "parent",
    disc: 'v.kind === "t" && "parent" in v',
    read: (v) => `${v}.parent`,
    write: (v) => `${v}.parent = "W"`,
    vals: [
      {
        id: "both",
        lit: '{ kind: "t", id: "i", parent: "p" }',
        vt: "B",
        isT: true,
        srcWrite: 'src.parent = "Z"',
      },
      { id: "one", lit: '{ kind: "t", id: "i" }', vt: "A", isT: false, srcWrite: 'src.id = "Z"' },
    ],
  },
  {
    id: "k3-no-discriminant",
    keys: ["a", "b", "c"],
    other: { key: "a", read: "v.a" },
    arms: ["{ a: number }", "{ b: string }", "{ c: boolean }"],
    T: 1,
    inKey: "b",
    disc: null,
    read: (v) => `${v}.b`,
    write: (v) => `${v}.b = "W"`,
    vals: [
      { id: "one", lit: '{ b: "s" }', vt: "B", isT: true, srcWrite: 'src.b = "Z"' },
      {
        id: "both",
        lit: '{ a: 1, b: "s" }',
        vt: "{ a: number; b: string }",
        isT: true,
        srcWrite: 'src.b = "Z"',
      },
    ],
  },
  {
    id: "k4-nested-required",
    keys: ["a", "b", "c"],
    other: null,
    arms: ["{ a: number }", "{ a: number; b: string }", "{ a: number; b: string; c: boolean }"],
    T: 1,
    inKey: "b",
    disc: null,
    read: (v) => `${v}.b`,
    write: (v) => `${v}.b = "W"`,
    vals: [
      { id: "both", lit: '{ a: 1, b: "s" }', vt: "B", isT: true, srcWrite: 'src.b = "Z"' },
      { id: "one", lit: "{ a: 1 }", vt: "A", isT: false, srcWrite: "src.a = 9" },
    ],
  },
  {
    id: "k5-optional-only",
    keys: ["a", "b", "c"],
    other: { key: "a", read: "v.a" },
    arms: ["{ a?: number }", "{ b?: string }", "{ c?: boolean }"],
    T: 1,
    inKey: "b",
    disc: null,
    read: (v) => `${v}.b`,
    write: (v) => `${v}.b = "W"`,
    vals: [
      { id: "one", lit: '{ b: "s" }', vt: "B", isT: true, srcWrite: 'src.b = "Z"' },
      {
        id: "both",
        lit: '{ a: 1, b: "s" }',
        vt: "{ a?: number; b?: string }",
        isT: true,
        srcWrite: 'src.b = "Z"',
      },
      { id: "empty", lit: "{}", vt: "B", isT: true, srcWrite: 'src.b = "Z"' },
    ],
  },
  {
    id: "k6-catch-all-literal",
    keys: ["op", "h", "t", "c"],
    other: { key: "t", read: "v.t" },
    arms: ['{ op: "open"; h: number }', "{ op: string; t: string }", '{ op: "close"; c: number }'],
    T: 0,
    inKey: "h",
    disc: 'v.op === "open" && "h" in v',
    read: (v) => `${v}.h`,
    write: (v) => `${v}.h = 7`,
    vals: [
      { id: "one", lit: '{ op: "open", h: 1 }', vt: "A", isT: true, srcWrite: "src.h = 9" },
      {
        id: "both",
        lit: '{ op: "open", h: 1, t: "x" }',
        vt: '{ op: "open"; h: number; t: string }',
        isT: true,
        srcWrite: "src.h = 9",
      },
      { id: "other", lit: '{ op: "zzz", t: "x" }', vt: "B", isT: false, srcWrite: 'src.t = "Z"' },
    ],
  },
  {
    id: "k7-index-signature-arm",
    keys: ["kind", "x", "z", "p"],
    other: { key: "p", read: "v.p" },
    arms: [
      '{ kind: "a"; x: number }',
      "{ [key: string]: string | number }",
      '{ kind: "c"; z: boolean }',
    ],
    T: 0,
    inKey: "x",
    disc: 'v.kind === "a" && "x" in v',
    read: (v) => `${v}.x`,
    write: (v) => `${v}.x = 7`,
    vals: [
      { id: "both", lit: '{ kind: "a", x: 1 }', vt: "A", isT: true, srcWrite: "src.x = 9" },
      { id: "other", lit: '{ p: "q", n: 2 }', vt: "B", isT: false, srcWrite: 'src.p = "Z"' },
    ],
  },
  {
    // pi's form: the target union re-arms a narrower union's arms with an optional member, one arm's only
    // extra member is `any`, and two other arms share one literal (sizes 3: control, 4: pi).
    id: "k8-rearmed-shared-literal",
    keys: ["kind", "id", "args", "part", "parent", "why"],
    other: null,
    sizes: [3, 4],
    arms: [
      '{ kind: "s"; id: string; args: any; parent?: string }',
      '{ kind: "p"; id: string; args: any; part: any; parent?: string }',
      '{ kind: "r"; src: "x" }',
      '{ kind: "r"; src: "y"; why: string }',
    ],
    srcUnion:
      '{ kind: "s"; id: string; args: any } | { kind: "p"; id: string; args: any; part: any }',
    T: 0,
    inKey: "id",
    disc: 'v.kind === "s"',
    read: (v) => `${v}.id`,
    write: (v) => `${v}.id = "W"`,
    vals: [
      {
        id: "one",
        lit: '{ kind: "s", id: "i", args: { c: 1 } }',
        vt: '{ kind: "s"; id: string; args: any }',
        isT: true,
        srcWrite: 'src.id = "Z"',
      },
      {
        id: "other",
        lit: '{ kind: "p", id: "i", args: { c: 1 }, part: "x" }',
        vt: '{ kind: "p"; id: string; args: any; part: any }',
        isT: false,
        srcWrite: 'src.id = "Z"',
      },
    ],
  },
];

const sources = ["lit", "widen", "fewer", "more", "unknown", "json", "rearm", "rearm-as"];
const ops = [
  "print",
  "in-read",
  "in-use",
  "in-other",
  "disc-read",
  "disc-use",
  "guard-read",
  "guard-use",
  "as-read",
  "as-use",
  "identity",
];

function program(kind, size, val, source, op) {
  const names = ["A", "B", "C", "D"].slice(0, size);
  const T = names[kind.T];
  if (T === undefined) return null;
  const L = [];
  L.push(`// ${kind.id} arms=${size} value=${val.id} source=${source} op=${op}`);
  names.forEach((n, i) => L.push(`type ${n} = ${kind.arms[i]};`));
  L.push(`type U = ${names.join(" | ")};`);
  L.push(`function useT(x: ${T}): string {`, `  return "useT:" + String(${kind.read("x")});`, `}`);
  if (op.startsWith("guard")) {
    L.push(
      `function isT(v: U): v is ${T} {`,
      `  return ${kind.disc ?? `"${kind.inKey}" in v`};`,
      `}`,
    );
  }
  let hasSrc = false;
  let open = 0;
  switch (source) {
    case "lit":
      L.push(`const v: U = ${val.lit};`);
      break;
    case "widen":
      L.push(`const src: ${val.vt} = ${val.lit};`, `const v: U = src;`);
      hasSrc = true;
      break;
    case "fewer":
      if (size < 3) return null;
      L.push(`const src: ${val.vt} = ${val.lit};`, `const sub: A | B = src;`, `const v: U = sub;`);
      hasSrc = true;
      break;
    case "more":
      L.push(
        `const src: ${val.vt} = ${val.lit};`,
        `function pick(n: number): U | number {`,
        `  return n > 0 ? src : n;`,
        `}`,
        `const wide = pick(process.argv.length);`,
        `if (typeof wide !== "number") {`,
        `const v: U = wide;`,
      );
      hasSrc = true;
      open = 1;
      break;
    case "rearm":
    case "rearm-as":
      if (!kind.srcUnion) return null;
      L.push(
        `type Narrow = ${kind.srcUnion};`,
        `const src: ${val.vt} = ${val.lit};`,
        `const narrow: Narrow = src;`,
      );
      L.push(source === "rearm" ? `const v: U = narrow;` : `const v = narrow as U;`);
      hasSrc = true;
      break;
    case "unknown":
      L.push(
        `const src: ${val.vt} = ${val.lit};`,
        `const boxed: unknown = src;`,
        `const v = boxed as U;`,
      );
      hasSrc = true;
      break;
    case "json":
      L.push(`const v = JSON.parse(${JSON.stringify(jsonText(val.lit))}) as U;`);
      break;
  }
  const narrowed = (cond, use) =>
    use
      ? [
          `if (${cond}) {`,
          `  console.log(useT(v));`,
          `  ${kind.write("v")};`,
          `  console.log(JSON.stringify(v));`,
          `} else {`,
          `  console.log("not T");`,
          `}`,
        ]
      : [
          `if (${cond}) {`,
          `  console.log("T", String(${kind.read("v")}));`,
          `} else {`,
          `  console.log("not T");`,
          `}`,
        ];
  switch (op) {
    case "print":
      L.push(
        `console.log(JSON.stringify(v));`,
        `console.log(Object.keys(v).join(","));`,
        `console.log(${kind.keys.map((k) => `"${k}" in v`).join(", ")});`,
      );
      break;
    case "in-read":
    case "in-use":
      L.push(...narrowed(`"${kind.inKey}" in v`, op.endsWith("use")));
      break;
    case "in-other":
      if (!kind.other) return null;
      L.push(
        `if ("${kind.other.key}" in v) {`,
        `  console.log("other", String(${kind.other.read}));`,
        `} else {`,
        `  console.log("not other");`,
        `}`,
      );
      break;
    case "disc-read":
    case "disc-use":
      if (!kind.disc) return null;
      L.push(...narrowed(kind.disc, op.endsWith("use")));
      break;
    case "guard-read":
    case "guard-use":
      L.push(...narrowed(`isT(v)`, op.endsWith("use")));
      break;
    case "as-read":
      L.push(`const t = v as ${T};`, `console.log("T", String(${kind.read("t")}));`);
      break;
    case "as-use":
      L.push(
        `const t = v as ${T};`,
        `console.log(useT(t));`,
        `${kind.write("t")};`,
        `console.log(JSON.stringify(v));`,
      );
      break;
    case "identity":
      if (!hasSrc || !val.srcWrite) return null;
      L.push(
        `console.log((v as unknown) === (src as unknown));`,
        `${val.srcWrite};`,
        `console.log(JSON.stringify(v));`,
        `console.log(JSON.stringify(src));`,
      );
      break;
  }
  for (let i = 0; i < open; i++) L.push(`}`);
  return L.join("\n") + "\n";
}

function jsonText(lit) {
  // The literals above are JSON after quoting their keys.
  return lit.replace(/([{,]\s*)([a-z]+):/g, '$1"$2":');
}

// --- cells -----------------------------------------------------------------
const cells = [];
for (const kind of kinds)
  for (const size of kind.sizes ?? [2, 3])
    for (const val of kind.vals)
      for (const source of sources)
        for (const op of ops) {
          const name = `${kind.id}.${size}.${val.id}.${source}.${op}`;
          if (filter && !filter.test(name)) continue;
          const text = program(kind, size, val, source, op);
          if (text === null) continue;
          const lying = (op.startsWith("as") || op.startsWith("guard")) && !val.isT;
          cells.push({ name, kind: kind.id, size, val: val.id, source, op, text, lying });
        }

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 128 + 6, signal, stdout, stderr });
    });
  });
}

async function one(cell) {
  const dir = join(out, "cells");
  const file = join(dir, cell.name + ".ts");
  writeFileSync(file, cell.text);
  const node = await run("node", ["--experimental-strip-types", "--no-warnings", file]);
  const bin = join(dir, cell.name + ".bin");
  const build = await run("node", [cli, "build", file, "-o", bin]);
  const log = build.stdout + build.stderr;
  let verdict;
  let native = null;
  if (build.code !== 0 || !existsSync(bin)) {
    const codes = [...new Set([...log.matchAll(/\bSC\d{4}\b/g)].map((m) => m[0]))];
    // SC0001 alone is a TypeScript error: the cell is not a program.
    if (codes.length > 0 && codes.every((c) => c === "SC0001")) verdict = "ts";
    else if (codes.includes("SC9001")) verdict = "ICE";
    else if (codes.length > 0) verdict = codes.filter((c) => c !== "SC0001").join("+");
    else verdict = "BUILD?";
  } else {
    native = await run(bin, []);
    if (native.signal || native.code === 134 || native.code === 139)
      verdict = native.code === 139 || native.signal === "SIGSEGV" ? "SEGV" : "ABORT";
    else if (native.stdout === node.stdout && native.code === node.code) verdict = "ok";
    else if (native.code !== node.code)
      verdict = /TypeError/.test(native.stderr) ? "TE" : `EXIT${native.code}`;
    else verdict = "SILENT";
  }
  const warn = [...new Set([...log.matchAll(/\bSC6\d{3}\b/g)].map((m) => m[0]))].join("+");
  return {
    ...cell,
    text: undefined,
    verdict,
    warn,
    node: {
      code: node.code,
      stdout: node.stdout,
      stderr: node.stderr.split("\n").slice(0, 4).join("\n"),
    },
    native: native && {
      code: native.code,
      stdout: native.stdout,
      stderr: native.stderr.split("\n").slice(0, 4).join("\n"),
    },
    build:
      build.code === 0
        ? ""
        : log
            .split("\n")
            .filter((l) => /SC\d{4}|TS\d{4}|error/i.test(l))
            .slice(0, 3)
            .join(" | ")
            .slice(0, 600),
  };
}

mkdirSync(join(out, "cells"), { recursive: true });
const results = [];
let next = 0;
async function worker() {
  while (next < cells.length) {
    const cell = cells[next++];
    results.push(await one(cell));
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
results.sort((a, b) => (a.name < b.name ? -1 : 1));
writeFileSync(join(out, "cells.json"), JSON.stringify(results, null, 1));

// --- the table ---------------------------------------------------------------
const rows = new Map();
for (const r of results) {
  const key = `${r.kind}\t${r.size}\t${r.val}\t${r.source}`;
  if (!rows.has(key)) rows.set(key, {});
  rows.get(key)[r.op] =
    r.verdict + (r.lying && r.verdict === "TE" ? "*" : "") + (r.warn ? "!" : "");
}
const lines = [["kind", "arms", "value", "source", ...ops].join("\t")];
for (const [key, row] of rows) lines.push([key, ...ops.map((op) => row[op] ?? "-")].join("\t"));
writeFileSync(join(out, "matrix.tsv"), lines.join("\n") + "\n");
const tally = {};
for (const r of results) {
  const v =
    r.lying && r.verdict === "TE" ? "TE*" : r.verdict.startsWith("SC") ? "refused" : r.verdict;
  tally[v] = (tally[v] ?? 0) + 1;
}
const perKind = {};
for (const r of results) {
  const v =
    r.lying && r.verdict === "TE" ? "TE*" : r.verdict.startsWith("SC") ? "refused" : r.verdict;
  (perKind[r.kind] ??= {})[v] = (perKind[r.kind][v] ?? 0) + 1;
}
const summary = [`cells ${results.length}`, JSON.stringify(tally)];
for (const [k, t] of Object.entries(perKind)) summary.push(`${k}\t${JSON.stringify(t)}`);
writeFileSync(join(out, "summary.txt"), summary.join("\n") + "\n");
console.log(summary.join("\n"));
