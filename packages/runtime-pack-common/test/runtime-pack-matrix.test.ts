import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createRuntimePackMatrix, variantsFor } from "../runtime-pack-matrix.mjs";

const runtimeSources = fileURLToPath(new URL("../../runtime/src", import.meta.url));

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

test("the typed stdio write slot selects the events build that carries it", () => {
  const plain = { stdioExtended: false, nodeIsland: false, workers: false };
  // Alone, the write slot selects its own build.
  expect(selected("scr_events.c", { ...plain, stdioWriteSlot: true }).defines).toEqual([
    "SCR_STDIO_WRITE_SLOT",
  ]);
  // Beside the other events features it keeps each one's defines.
  expect(
    selected("scr_events.c", { ...plain, stdioExtended: true, stdioWriteSlot: true }).defines,
  ).toEqual(["SCR_STDIO_EXTENDED", "SCR_STDIO_WRITE_SLOT"]);
  expect(
    selected("scr_events.c", { ...plain, nodeIsland: true, stdioWriteSlot: true }).defines,
  ).toEqual(["SCR_NODE_ISLANDS", "SCR_STDIO_WRITE_SLOT"]);
  expect(
    selected("scr_events.c", {
      ...plain,
      stdioExtended: true,
      nodeIsland: true,
      stdioWriteSlot: true,
    }).defines,
  ).toEqual(["SCR_STDIO_EXTENDED", "SCR_NODE_ISLANDS", "SCR_STDIO_WRITE_SLOT"]);
  // A program that never reaches the write slot keeps the old object.
  expect(
    selected("scr_events.c", {
      ...plain,
      stdioExtended: true,
      nodeIsland: true,
      stdioWriteSlot: false,
    }).defines,
  ).toEqual(["SCR_STDIO_EXTENDED", "SCR_NODE_ISLANDS"]);
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

test("scr_lib.c builds once per flavor for a dynamic link, plus the static link's build", () => {
  // A file read brands its bytes and fs.watchFile's stat entry points are
  // always defined, so neither a read nor a poll selects a second build. The
  // one other build is the link's: a static executable cannot load NSS
  // modules, so it reads /etc/passwd itself (SCR_STATIC_PASSWD), and every
  // dynamically linked build keeps the getpwuid_r object.
  // The unit's other object is the JavaScript object model twin (t262-da
  // §J), which answers the checked-dynamic Date annexB accessors.
  const unit = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_lib.c");
  expect(new Set(unit.variants.map((v: { id: string }) => v.id))).toEqual(
    new Set([
      "default",
      "default-workers",
      "static-passwd",
      "static-passwd-workers",
      "js-om",
      "js-om-workers",
      "js-om-static-passwd",
      "js-om-static-passwd-workers",
    ]),
  );
  const plain = { workers: false, watchFile: false };
  expect(selected("scr_lib.c", plain).defines).toEqual([]);
  expect(selected("scr_lib.c", { ...plain, watchFile: true }).defines).toEqual([]);
  expect(selected("scr_lib.c", { ...plain, workers: true, watchFile: true }).defines).toEqual([
    "SCR_WORKERS",
  ]);
  // staticLink is the link plan's fact, and only it selects the second build.
  expect(selected("scr_lib.c", { ...plain, staticLink: true }).defines).toEqual([
    "SCR_STATIC_PASSWD",
  ]);
  expect(selected("scr_lib.c", { ...plain, workers: true, staticLink: true }).defines).toEqual([
    "SCR_STATIC_PASSWD",
    "SCR_WORKERS",
  ]);
  // A static executable whose program selects the object model build keeps
  // the passwd reader: one build carries both defines.
  expect(
    new Set(selected("scr_lib.c", { ...plain, staticLink: true, jsObjectModel: true }).defines),
  ).toEqual(new Set(["SCR_STATIC_PASSWD", "SCR_JS_OBJECT_MODEL"]));
  expect(
    new Set(
      selected("scr_lib.c", { ...plain, workers: true, staticLink: true, jsObjectModel: true })
        .defines,
    ),
  ).toEqual(new Set(["SCR_STATIC_PASSWD", "SCR_JS_OBJECT_MODEL", "SCR_WORKERS"]));
  expect(selected("scr_lib.c", { ...plain, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
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
  expect(variants.map((variant: { id: string }) => variant.id)).toEqual(["default", "js-om"]);
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
  // A program that runs a Node island selects no build of its own: the
  // island paths call through the table the island units install, so it
  // links the default object, or the object model build it may also carry.
  expect(selected("scr_json.c", { workers: false, nodeIsland: true }).defines).toEqual([]);
  expect(
    selected("scr_json.c", { workers: false, jsObjectModel: true, nodeIsland: true }).defines,
  ).toEqual(["SCR_JS_OBJECT_MODEL"]);
  // A partial record assertion selects nothing: the view slot answers NULL in
  // every build, so a program with one keeps the build its other features
  // name, alone or beside the object model build.
  expect(selected("scr_json.c", { workers: false, recordViewPartial: true }).defines).toEqual([]);
  expect(
    selected("scr_json.c", {
      workers: false,
      jsObjectModel: true,
      nodeIsland: true,
      recordViewPartial: true,
    }).defines,
  ).toEqual(["SCR_JS_OBJECT_MODEL"]);
  // A program that reaches none of the features keeps the default object.
  expect(selected("scr_json.c", { workers: false }).id).toBe("default");
  expect(selected("scr_json.c", { workers: false }).defines).toEqual([]);
});

test("a dynamic Date annexB accessor selects the JavaScript object model build", () => {
  // A program whose IR calls getYear/setYear on a dynamic receiver has the
  // dateAnnexB fact, which ORs into jsObjectModel (t262-da §J). scr_lib.c
  // builds once per flavor (#2765), so its one object model twin answers
  // both names and the accessor adds no variant column of its own.
  const plain = { workers: false, jsObjectModel: false };
  expect(selected("scr_lib.c", { ...plain, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
  ]);
  // The worker build keeps its thread block beside the object model.
  expect(selected("scr_lib.c", { workers: true, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
    "SCR_WORKERS",
  ]);
  // A program that reaches neither keeps the default object, byte for byte.
  expect(selected("scr_lib.c", plain).defines).toEqual([]);
  expect(selected("scr_lib.c", { workers: true, jsObjectModel: false }).defines).toEqual([
    "SCR_WORKERS",
  ]);
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
  // Node islands select no build of the inspect unit: island values print
  // through the table the island units install.
  expect(
    selected("scr_inspect.c", { ...plain, jsObjectModel: true, nodeIsland: true }).defines,
  ).toEqual(["SCR_JS_OBJECT_MODEL"]);
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

test("the shape store probe declines __proto__ in the object model build", () => {
  // A dynamic store to the `__proto__` member is Object.prototype's setter,
  // not a field the receiver's shape grows (object-literals.ts, scr_json.c),
  // so the probe in scr_js_object.c declines it there; every other program
  // keeps the default object, byte for byte.
  const plain = { dynTier: false, jsObjectModel: false, workers: false };
  expect(selected("scr_js_object.c", { ...plain, dynTier: true }).defines).toEqual([]);
  expect(
    selected("scr_js_object.c", { ...plain, dynTier: true, jsObjectModel: true }).defines,
  ).toEqual(["SCR_JS_OBJECT_MODEL"]);
});

test("a dynamic global read selects the host-global build of the global unit", () => {
  // A computed read of the global object, or `… in globalThis`, arms the
  // check for the Node globals the native runtime does not implement
  // (host-globals.ts); every other program keeps the default object.
  const plain = { hostAbsentGlobals: false, workers: false };
  expect(selected("scr_node_builtin.c", plain).defines).toEqual([]);
  expect(selected("scr_node_builtin.c", { ...plain, hostAbsentGlobals: true }).defines).toEqual([
    "SCR_GLOBAL_HOST_ABSENT",
  ]);
  // A worker program keeps its thread-state build AND the check.
  expect(
    selected("scr_node_builtin.c", { hostAbsentGlobals: true, workers: true }).defines,
  ).toEqual(["SCR_GLOBAL_HOST_ABSENT", "SCR_WORKERS"]);
});

test("reading a spawnSync result's error selects the child build with its fields", () => {
  // A program that reads `.error` links the build that keeps the spawn errno
  // and argv on the result and stamps Node's errnoException fields.
  expect(selected("scr_child.c", { workers: false, childErrorFields: true }).defines).toEqual([
    "SCR_CHILD_ERR_FIELDS",
  ]);
  // A program that spawns but never reads `.error` keeps the default object
  // and the result container exactly as they were, byte for byte.
  expect(selected("scr_child.c", { workers: false, childErrorFields: false }).defines).toEqual([]);
});

test("extended spawn options beside an error read keep both child builds", () => {
  // The cwd/input/shell entries and the errnoException fields live in two
  // builds of scr_child.c; a program that passes those options and reads
  // `.error` needs one object carrying both, not the options build alone.
  expect(
    selected("scr_child.c", { workers: false, childOptionExt: true, childErrorFields: true })
      .defines,
  ).toEqual(["SCR_CHILD_CP_OPTIONS", "SCR_CHILD_ERR_FIELDS"]);
  // Each feature alone keeps its own build.
  expect(
    selected("scr_child.c", { workers: false, childOptionExt: true, childErrorFields: false })
      .defines,
  ).toEqual(["SCR_CHILD_CP_OPTIONS"]);
});

test("Node islands select no build of the units that reach them through the installed table", () => {
  // util.inspect and instanceof of an island value, an island error's
  // constructor and its uncaught report call through ScrNiDynOps, which
  // scr_node_island_handle.c installs: an island program links the same
  // object of these units as every other program.
  for (const source of [
    "scr_json.c",
    "scr_inspect.c",
    "scr_exception.c",
    "scr_dyn_builtin_class.c",
  ]) {
    for (const variant of variantsFor(source)) {
      expect(variant.when.nodeIsland).toBeUndefined();
      expect(variant.defines).not.toContain("SCR_NODE_ISLANDS");
    }
    expect(selected(source, { workers: false, nodeIsland: true }).defines).toEqual(
      selected(source, { workers: false }).defines,
    );
  }
  expect(variantsFor("scr_exception.c").map((variant: { id: string }) => variant.id)).toEqual([
    "default",
  ]);
  // instanceof over web stream handles keeps its build, with or without islands.
  expect(
    selected("scr_dyn_builtin_class.c", { workers: false, webStreams: true, nodeIsland: true })
      .defines,
  ).toEqual(["SCR_HANDLE_CLASSES"]);
});

test("a unit that tests SCR_NODE_ISLANDS has a build that defines it", () => {
  // A block under the define in a unit with no such build is compiled into
  // no program, so an island path added there would never run. In those
  // units an island path calls through the installed table instead.
  const testsDefine = /^[ \t]*#[ \t]*(?:if|ifdef|ifndef|elif)\b.*\bSCR_NODE_ISLANDS\b/m;
  const units = readdirSync(runtimeSources).filter((name) => {
    if (!name.endsWith(".c")) return false;
    return testsDefine.test(readFileSync(join(runtimeSources, name), "utf8"));
  });
  expect(units).toContain("scr_async.c");
  const withoutBuild = units.filter(
    (unit) =>
      !variantsFor(unit).some((variant: { defines: string[] }) =>
        variant.defines.includes("SCR_NODE_ISLANDS"),
      ),
  );
  expect(withoutBuild).toEqual([]);
});
