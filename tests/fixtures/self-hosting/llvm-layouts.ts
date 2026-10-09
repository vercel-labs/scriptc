import { readFileSync } from "node:fs";
import { deserializeModule } from "../../../packages/compiler/src/ir/serialize.js";
import { computeTraced } from "../../../packages/compiler/src/backend/cycle-analysis.js";
import { buildClassGraph, classFieldIndex, type ClassHost } from "../../../packages/compiler/src/backend/llvm/classes.js";
import { emitLlvmLayouts } from "../../../packages/compiler/src/backend/llvm/layouts.js";
import { LlvmDebugInfo } from "../../../packages/compiler/src/backend/llvm/debug-info.js";
import { LlWalkers, type WalkerHost } from "../../../packages/compiler/src/backend/llvm/walkers.js";
import { BlockBuilder } from "../../../packages/compiler/src/backend/llvm/blocks.js";
import { f64Lit } from "../../../packages/compiler/src/backend/llvm/common.js";
import { mangleClassObj } from "../../../packages/compiler/src/backend/mangle.js";
import { type IrType } from "../../../packages/compiler/src/ir/ir.js";

interface Request {
  bits: 32 | 64;
  clones: string[];
  classObjects: string[];
  sources: { file: string; text: string }[];
  writers?: IrType[];
  joinUnions?: string[];
  indent?: boolean;
}

try {
  const mod = deserializeModule(readFileSync(process.argv[2]!, "utf8"));
  const request = JSON.parse(readFileSync(process.argv[3]!, "utf8")) as Request;
  const declarations = new Set<string>();
  const strings: string[] = [];
  const literals: string[] = [];
  const units: { union: string; tag: number }[] = [];
  let needsOom = false;
  let needsBadTag = false;
  const traced = computeTraced(mod);
  const host: ClassHost & WalkerHost = {
    declare: (decl) => { declarations.add(decl); },
    needOom: () => { needsOom = true; },
    needBadTag: () => { needsBadTag = true; },
    internLiteral: (text) => {
      let index = literals.indexOf(text);
      if (index === -1) { index = literals.length; literals.push(text); }
      return `@native_literal_${index}`;
    },
    sizeType: request.bits === 32 ? "i32" : "i64",
    cycleColorOffset: request.bits === 32 ? 12 : 16,
    tracedShapes: traced.shapes,
    tracedUnions: traced.unions,
    recordsById: new Map((mod.records ?? []).map((record) => [record.id, record])),
    // emitLlvmModule enables the inline allocator for 64-bit host targets.
    inlineAlloc: request.bits === 64,
    unionsById: new Map((mod.unions ?? []).map((union) => [union.id, union])),
    recordCloneShapes: new Set(request.clones),
    rcHelpers: null,
    unitInstanceRef: (union, tag) => {
      let index = units.findIndex((unit) => unit.union === union && unit.tag === tag);
      if (index === -1) {
        index = units.length;
        units.push({ union, tag });
      }
      return `@native_unit_${index}`;
    },
    cstr: (text) => {
      let index = strings.indexOf(text);
      if (index === -1) { index = strings.length; strings.push(text); }
      return `@native_string_${index}`;
    },
  };
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const graph = buildClassGraph(mod, functions);
  const classObjects = new Map(request.classObjects.map((name) => [name, { nameSym: `@name_${mangleClassObj(name)}` }]));
  const typeName = (type: IrType): string => type.kind === "void" ? "void" : type.kind === "f64" || type.kind === "date" ? "double" : type.kind === "bool" ? "i1" : "ptr";
  const layouts = emitLlvmLayouts(host, mod, graph, classObjects, functions, typeName);
  const walkers = new LlWalkers(host);
  const helpers: string[] = [];
  for (const type of request.writers ?? []) helpers.push(walkers.jsonWriteHelper(type));
  for (const union of request.joinUnions ?? []) helpers.push(walkers.unionJoinHelper(union));
  if (request.indent) helpers.push(walkers.jsonIndentHelper());
  const classes = [...graph.values()].map((meta) => ({
    name: meta.def.name, root: meta.root.def.name, base: meta.base?.def.name ?? null,
    children: meta.children.map((child) => child.def.name), pre: meta.pre, post: meta.post,
    hierarchy: meta.hierarchy,
    fields: meta.def.fields.map((field) => ({ name: field.name, index: classFieldIndex(meta, field.name).index })),
    slots: meta.slots.map((slot) => ({ method: slot.method, declarer: slot.declarer.def.name, function: slot.fn.name })),
  }));
  const debug = new LlvmDebugInfo(mod.sourceFile, new Map(request.sources.map((source) => [source.file, source.text])), request.bits, mod.unions ?? []);
  const bindings: string[] = [];
  for (const global of mod.globals ?? []) bindings.push(debug.global(global) ?? "");
  for (const fn of mod.functions) {
    const scope = debug.function(fn);
    bindings.push(scope ?? "");
    for (const local of fn.locals) {
      const param = fn.params.findIndex((param) => param.localId === local.id);
      const entry = debug.local(local, scope, param + 1, fn.captures?.some((capture) => capture.localId === local.id) ?? false);
      bindings.push(entry === null ? "" : JSON.stringify(entry));
    }
    for (const stmt of fn.body) bindings.push(debug.location(stmt.loc, scope) ?? "");
  }
  const blocks = new BlockBuilder();
  blocks.countedLoop(f64Lit(3), (index, next) => {
    blocks.line(`call void @consume(double ${index})`);
    blocks.br(next);
    blocks.line("unreachable text must be dropped");
  });
  blocks.terminate("ret void");
  console.log(JSON.stringify({ layouts, classes, declarations: [...declarations], strings, literals, units, needsOom, needsBadTag, helpers, walkers: walkers.defs, bindings, debug: debug.render(), block: blocks.render() }));
} catch (error) {
  if (error instanceof Error) console.log(error.name + ": " + error.message);
  else console.log("unexpected thrown value");
  process.exitCode = 1;
}
