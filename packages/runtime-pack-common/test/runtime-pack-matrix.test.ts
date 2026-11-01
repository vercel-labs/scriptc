import { expect, test } from "vitest";
import { createRuntimePackMatrix, variantsFor } from "../runtime-pack-matrix.mjs";

const matrix = createRuntimePackMatrix({
  target: { object_format: "elf" },
  compileFlags: [],
  systemLibraries: [],
});

/** The runtime pack's variant selection: the matching variant with the
 * most conditions, ties by id. */
function selected(
  source: string,
  features: Record<string, boolean>,
): { id: string; defines: string[] } {
  const unit = matrix.runtime_units.find((u: { source: string }) => u.source === source);
  const matches = unit.variants.filter((variant: { when: Record<string, boolean> }) =>
    Object.entries(variant.when).every(([name, expected]) => features[name] === expected),
  );
  matches.sort(
    (a: { when: object; id: string }, b: { when: object; id: string }) =>
      Object.keys(b.when).length - Object.keys(a.when).length || a.id.localeCompare(b.id),
  );
  return matches[0];
}

test("scr_events.c builds once per flavor, whatever the program's features", () => {
  // The stdio extensions, the process extras, the typed write slot and the
  // island listeners all live in the one build; only workers needs its own.
  const unit = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_events.c");
  expect(unit.variants.map((v: { id: string }) => v.id)).toEqual(["default", "default-workers"]);
  const plain = { workers: false, nodeIsland: false, processExtras: false };
  expect(selected("scr_events.c", plain).defines).toEqual([]);
  // The features the other units still key on select nothing here.
  expect(
    selected("scr_events.c", { ...plain, nodeIsland: true, processExtras: true }).defines,
  ).toEqual([]);
  expect(selected("scr_events.c", { ...plain, workers: true, nodeIsland: true }).defines).toEqual([
    "SCR_WORKERS",
  ]);
});

test("web streams and Node islands select an async build that defines both", () => {
  const variant = selected("scr_async.c", { webStreams: true, nodeIsland: true, workers: false });
  expect(variant.defines).toEqual(
    expect.arrayContaining(["SCR_NATIVE_REACTIONS", "SCR_NODE_ISLANDS"]),
  );
  // Each feature alone still selects its own build, byte for byte.
  expect(
    selected("scr_async.c", { webStreams: true, nodeIsland: false, workers: false }).defines,
  ).toEqual(["SCR_NATIVE_REACTIONS"]);
  expect(
    selected("scr_async.c", { webStreams: false, nodeIsland: true, workers: false }).defines,
  ).toEqual(["SCR_NODE_ISLANDS"]);
  expect(
    selected("scr_async.c", { webStreams: false, nodeIsland: false, workers: false }).defines,
  ).toEqual([]);
});

test("scr_lib.c builds once per flavor, whatever the program's features", () => {
  // A file read brands its bytes and fs.watchFile's stat entry points are
  // always defined, so neither a read nor a poll selects a second build.
  const unit = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_lib.c");
  expect(unit.variants.map((v: { id: string }) => v.id)).toEqual(["default", "default-workers"]);
  const plain = { workers: false, watchFile: false };
  expect(selected("scr_lib.c", plain).defines).toEqual([]);
  expect(selected("scr_lib.c", { ...plain, watchFile: true }).defines).toEqual([]);
  expect(selected("scr_lib.c", { ...plain, workers: true, watchFile: true }).defines).toEqual([
    "SCR_WORKERS",
  ]);
});

test("scr_json builds one object per flavor, plus its object model twin", () => {
  // The JavaScript object model build (t262-da §J) is one column for every
  // runtime feature only a JavaScript source reaches: each scr_json.c build
  // gets one twin, so any combination of features selects a build that
  // carries the object model's code. The unit has no partial record view
  // build: its view slot answers NULL for a field a partial record view does
  // not have in every build.
  const variants = variantsFor("scr_json.c");
  expect(variants.map((variant: { id: string }) => variant.id)).toEqual([
    "default",
    "node-island",
    "js-om",
    "js-om-node-island",
  ]);
  for (const variant of variants) {
    if (!variant.id.startsWith("js-om")) continue;
    expect(variant.when.jsObjectModel).toBe(true);
    expect(variant.defines).toContain("SCR_JS_OBJECT_MODEL");
  }
  // A program with the object model, and nothing else, selects its build...
  expect(selected("scr_json.c", { workers: false, jsObjectModel: true }).id).toBe("js-om");
  expect(selected("scr_json.c", { workers: false, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
  ]);
  // ...and keeps the worker build when the program starts threads.
  expect(selected("scr_json.c", { workers: true, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
    "SCR_WORKERS",
  ]);
  // A program that runs a Node island selects the island build, alone and
  // beside the object model build it may also carry.
  expect(selected("scr_json.c", { workers: false, nodeIsland: true }).defines).toEqual([
    "SCR_NODE_ISLANDS",
  ]);
  expect(
    selected("scr_json.c", { workers: false, jsObjectModel: true, nodeIsland: true }).defines,
  ).toEqual(["SCR_NODE_ISLANDS", "SCR_JS_OBJECT_MODEL"]);
  // A partial record assertion selects nothing: the view slot answers NULL in
  // every build, so a program with one keeps the build its other features
  // name, alone or beside the island and object model builds.
  expect(selected("scr_json.c", { workers: false, recordViewPartial: true }).defines).toEqual([]);
  expect(
    selected("scr_json.c", { workers: false, nodeIsland: true, recordViewPartial: true }).defines,
  ).toEqual(["SCR_NODE_ISLANDS"]);
  expect(
    selected("scr_json.c", {
      workers: false,
      jsObjectModel: true,
      nodeIsland: true,
      recordViewPartial: true,
    }).defines,
  ).toEqual(["SCR_NODE_ISLANDS", "SCR_JS_OBJECT_MODEL"]);
  // A program that reaches none of the features keeps the default object.
  expect(selected("scr_json.c", { workers: false }).id).toBe("default");
  expect(selected("scr_json.c", { workers: false }).defines).toEqual([]);
});

test("the BigIntStats unit follows its own member-read gate, not bigint", () => {
  const unit = matrix.runtime_units.find(
    (u: { source: string }) => u.source === "scr_stats_bigint.c",
  );
  // Every bigint value turns the bigint feature on; only the member reads
  // name bigstats, so a bigint program keeps this unit out of its binary.
  expect(unit.predicate).toBe("bigstats");
});

test("the BigInt element kinds ride the JavaScript object model build", () => {
  // effectiveRuntimeFeatures ORs bigintBytes into jsObjectModel, so a program
  // that reads BigInt64Array or BigUint64Array selects the object model build
  // of every unit that reads an element as a BigInt (t262-da §J): scr_bytes.c
  // defines the element accessors, and json, inspect, assert, dyn-invoke and
  // console call them, all from build-selected objects together. No feature
  // gets a build column of its own.
  const plain = {
    jsObjectModel: false,
    textDecoderLegacy: false,
    webStreams: false,
    nodeIsland: false,
    workers: false,
  };
  expect(selected("scr_bytes.c", { ...plain, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
  ]);
  expect(
    selected("scr_bytes.c", { ...plain, jsObjectModel: true, textDecoderLegacy: true }).defines,
  ).toEqual(["SCR_TEXT_DECODER_LEGACY", "SCR_JS_OBJECT_MODEL"]);
  // The units with other builds keep each one's object model counterpart: a
  // program with Node islands selects the build that carries both.
  expect(
    selected("scr_inspect.c", { ...plain, jsObjectModel: true, nodeIsland: true }).defines,
  ).toEqual(["SCR_NODE_ISLANDS", "SCR_JS_OBJECT_MODEL"]);
  expect(selected("scr_console_native.c", { ...plain, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
  ]);
  // A program with none of the facts selects the default object of every
  // unit, exactly as before.
  for (const source of [
    "scr_bytes.c",
    "scr_json.c",
    "scr_inspect.c",
    "scr_assert.c",
    "scr_dyn_invoke.c",
    "scr_console_native.c",
  ]) {
    expect(selected(source, plain).defines).toEqual([]);
  }
});
