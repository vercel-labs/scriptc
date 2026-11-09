import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import * as packMatrix from "../runtime-pack-matrix.mjs";
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

test("scr_events.c builds once per flavor, and once more for the terminal color methods", () => {
  // The stdio extensions, the process extras, the typed write slot and the
  // island listeners all live in the one build; only workers needs its own.
  // The second build is the one whose stream object asks scr_tty_colors.c
  // for getColorDepth and hasColors: a hook in the one build would change
  // the object every program with process events links.
  const unit = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_events.c");
  expect(unit.variants.map((v: { id: string }) => v.id)).toEqual([
    "default",
    "default-workers",
    "tty-colors",
    "tty-colors-workers",
  ]);
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

test("Node islands select the dynamic promise build that adopts island thenables", () => {
  const plain = { warningReplace: false, processExtras: false, nodeIsland: false, workers: false };
  expect(selected("scr_async_dyn.c", { ...plain, nodeIsland: true }).defines).toEqual([
    "SCR_NODE_ISLANDS",
  ]);
  // Beside the unit's other builds it keeps each one's defines.
  expect(
    selected("scr_async_dyn.c", { ...plain, processExtras: true, nodeIsland: true }).defines,
  ).toEqual(["SCR_PROCESS_EXTRAS", "SCR_NODE_ISLANDS"]);
  expect(
    selected("scr_async_dyn.c", {
      ...plain,
      warningReplace: true,
      processExtras: true,
      nodeIsland: true,
    }).defines,
  ).toEqual(["SCR_WARNING_REPLACE", "SCR_PROCESS_EXTRAS", "SCR_NODE_ISLANDS"]);
  // A program without islands keeps the objects it had.
  expect(selected("scr_async_dyn.c", plain).defines).toEqual([]);
  expect(selected("scr_async_dyn.c", { ...plain, processExtras: true }).defines).toEqual([
    "SCR_PROCESS_EXTRAS",
  ]);
});

test("Node islands select the invoke build that reaches an island promise's own methods", () => {
  const plain = { jsObjectModel: false, nodeIsland: false, workers: false };
  expect(selected("scr_dyn_invoke.c", { ...plain, nodeIsland: true }).defines).toEqual([
    "SCR_NODE_ISLANDS",
  ]);
  expect(
    selected("scr_dyn_invoke.c", { ...plain, nodeIsland: true, jsObjectModel: true }).defines,
  ).toEqual(["SCR_NODE_ISLANDS", "SCR_JS_OBJECT_MODEL"]);
  // A program without islands keeps the objects it had.
  expect(selected("scr_dyn_invoke.c", plain).defines).toEqual([]);
  expect(selected("scr_dyn_invoke.c", { ...plain, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
  ]);
});

test("a process stream held as a value selects the island build that shares its write", () => {
  // The unit that joins the island's process.stdout.write to the program's
  // links only with both features.
  const unit = matrix.runtime_units.find(
    (u: { source: string }) => u.source === "scr_node_island_stdio.c",
  );
  expect(unit.predicate).toEqual({ all: ["nodeIsland", "stdioObject"] });
  expect(selected("scr_node_island.c", { stdioObject: true, workers: false }).defines).toEqual([
    "SCR_NODE_ISLAND_STDIO",
  ]);
  // Every other program with islands keeps the default object.
  expect(selected("scr_node_island.c", { stdioObject: false, workers: false })).toMatchObject({
    id: "default",
    defines: [],
  });
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
  const unit = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_lib.c");
  expect(unit.variants.map((v: { id: string }) => v.id)).toEqual([
    "default",
    "default-workers",
    "static-passwd",
    "static-passwd-workers",
  ]);
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
    "fn-member-props",
    "js-om",
    "js-om-fn-member-props",
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
  // A program that runs a Node island selects no build of its own: the
  // island paths call through the table the island units install, so it
  // links the default object, or the object model build it may also carry.
  expect(selected("scr_json.c", { workers: false, nodeIsland: true }).defines).toEqual([]);
  expect(
    selected("scr_json.c", { workers: false, jsObjectModel: true, nodeIsland: true }).defines,
  ).toEqual(["SCR_JS_OBJECT_MODEL"]);
  // A program that writes, defines or deletes a function's inherited member
  // name selects the fn-member-props build, alone and beside the object
  // model build it may also carry; a Node island adds no define to it.
  expect(selected("scr_json.c", { workers: false, fnMemberProps: true }).defines).toEqual([
    "SCR_FN_MEMBER_PROPS",
  ]);
  expect(
    selected("scr_json.c", { workers: false, nodeIsland: true, fnMemberProps: true }).defines,
  ).toEqual(["SCR_FN_MEMBER_PROPS"]);
  expect(
    selected("scr_json.c", {
      workers: false,
      jsObjectModel: true,
      nodeIsland: true,
      fnMemberProps: true,
    }).defines,
  ).toEqual(["SCR_FN_MEMBER_PROPS", "SCR_JS_OBJECT_MODEL"]);
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

test("the dynamic call path reads an own call/apply/bind in one build", () => {
  // scr_dyn_invoke.c reads a function's own call/apply/bind before the
  // native lowering, in the same build as scr_json.c's member write path
  // (both compile with SCR_FN_MEMBER_PROPS for a fnMemberProps program).
  const plain = { workers: false, jsObjectModel: false, fnMemberProps: false };
  expect(selected("scr_dyn_invoke.c", plain).defines).toEqual([]);
  expect(selected("scr_dyn_invoke.c", { ...plain, fnMemberProps: true }).defines).toEqual([
    "SCR_FN_MEMBER_PROPS",
  ]);
  // A program that also needs the object model build keeps one object.
  expect(
    selected("scr_dyn_invoke.c", { ...plain, jsObjectModel: true, fnMemberProps: true }).defines,
  ).toEqual(["SCR_FN_MEMBER_PROPS", "SCR_JS_OBJECT_MODEL"]);
  // And a worker program keeps its thread-state build.
  expect(
    selected("scr_dyn_invoke.c", { workers: true, jsObjectModel: false, fnMemberProps: true })
      .defines,
  ).toEqual(["SCR_FN_MEMBER_PROPS", "SCR_WORKERS"]);
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

test("fs stream options that can hold a signal select the signal build of the fs stream unit", () => {
  // The build applies options.signal with the event-target unit's abort
  // listener; a program whose stream options cannot hold one keeps the
  // default object, byte for byte.
  expect(selected("scr_fs_stream.c", { workers: false, fsStreamSignal: true }).defines).toEqual([
    "SCR_FS_STREAM_SIGNAL",
  ]);
  expect(selected("scr_fs_stream.c", { workers: false, fsStreamSignal: false }).defines).toEqual(
    [],
  );
  expect(selected("scr_fs_stream.c", { workers: true, fsStreamSignal: true }).defines).toEqual([
    "SCR_FS_STREAM_SIGNAL",
    "SCR_WORKERS",
  ]);
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

test("a worker program links the symbol and assert units its env option needs", () => {
  // The Worker env option compares against worker_threads.SHARE_ENV, whose
  // symbol lives in scr_symbol.c, so a worker program selects that unit even
  // when it never uses a symbol itself; scr_symbol.c assembles symbol
  // equality messages through scr_assert.c, which travels with it.
  const symbol = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_symbol.c");
  expect(symbol.predicate).toEqual({ any: ["symbol", "workers"] });
  const assert = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_assert.c");
  expect(assert.predicate).toEqual({ any: ["assert", "regex", "symbol", "workers"] });
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

test("the terminal color methods are a unit of their own behind one build of the events unit", () => {
  const unit = matrix.runtime_units.find(
    (u: { source: string }) => u.source === "scr_tty_colors.c",
  );
  expect(unit.predicate).toEqual({ all: ["events", "ttyColors"] });
  expect(selected("scr_events.c", { ttyColors: true, workers: false }).defines).toEqual([
    "SCR_TTY_COLORS",
  ]);
  // Every other program keeps the default events object.
  expect(selected("scr_events.c", { ttyColors: false, workers: false })).toMatchObject({
    id: "default",
    defines: [],
  });
});

test("Node's pipe lifecycle is a unit of its own and the stream unit has no build for it", () => {
  // A program that pipes links the unit that installs the lifecycle into
  // the stream unit; the stream unit itself builds once more only for the
  // write-error callbacks it already had.
  const unit = matrix.runtime_units.find(
    (u: { source: string }) => u.source === "scr_stream_pipe_events.c",
  );
  expect(unit.predicate).toEqual({ all: ["stream", "streamPipeEvents"] });
  const stream = matrix.runtime_units.find((u: { source: string }) => u.source === "scr_stream.c");
  expect(stream.variants.some((v: { defines: string[] }) => v.defines.length > 2)).toBe(false);
  expect(
    stream.variants
      .flatMap((v: { defines: string[] }) => v.defines)
      .filter((d: string) => /PIPE/.test(d)),
  ).toEqual([]);
});

test("pausing a child's output selects the child build with the flowing state", () => {
  // pause(), resume(), isPaused() and readableFlowing on a child stream link
  // the build whose stream handle keeps Node's flowing state.
  expect(selected("scr_child.c", { workers: false, childStreamFlow: true }).defines).toEqual([
    "SCR_CHILD_STREAM_FLOW",
  ]);
  // A program that only listens to a child's output keeps the default
  // object, byte for byte.
  expect(selected("scr_child.c", { workers: false, childStreamFlow: false }).defines).toEqual([]);
  // The flowing state beside the other child builds is one object carrying
  // every define, not the build with the most recent feature alone.
  expect(
    selected("scr_child.c", { workers: false, childOptionExt: true, childStreamFlow: true })
      .defines,
  ).toEqual(["SCR_CHILD_CP_OPTIONS", "SCR_CHILD_STREAM_FLOW"]);
  expect(
    selected("scr_child.c", { workers: false, childErrorFields: true, childStreamFlow: true })
      .defines,
  ).toEqual(["SCR_CHILD_ERR_FIELDS", "SCR_CHILD_STREAM_FLOW"]);
  expect(
    selected("scr_child.c", {
      workers: false,
      childOptionExt: true,
      childErrorFields: true,
      childStreamFlow: true,
    }).defines,
  ).toEqual(["SCR_CHILD_CP_OPTIONS", "SCR_CHILD_ERR_FIELDS", "SCR_CHILD_STREAM_FLOW"]);
});

test("the installed island table has every entry the shared units call through it", () => {
  // The shared units build once, so an island path in them is a call through
  // ScrNiDynOps (a native weak collection keyed by an island object, for
  // one: scr_json.c's weak_get, weak_test and weak_set). An entry the island
  // unit's initializer leaves out is NULL there, and nothing notices before
  // an island program takes that path.
  const source = (name: string): string => readFileSync(join(runtimeSources, name), "utf8");
  const struct = /typedef struct ScrNiDynOps \{([\s\S]*?)\n\} ScrNiDynOps;/.exec(
    source("scr_node_island.h"),
  );
  const declared = [...struct![1]!.matchAll(/\(\*(\w+)\)\(/g)].map((match) => match[1]!);
  const table = /static const ScrNiDynOps nh_dyn_ops = \{([\s\S]*?)\n\};/.exec(
    source("scr_node_island_handle.c"),
  );
  const installed = [...table![1]!.matchAll(/^\s*\.(\w+) = /gm)].map((match) => match[1]!);
  // In the struct's order: a new entry goes last in both, because the
  // runtime every program links reads the table by offset.
  expect(installed).toEqual(declared);
  const called = new Set<string>();
  for (const name of readdirSync(runtimeSources).filter((name) => name.endsWith(".c")))
    for (const match of source(name).matchAll(/\bscr_ni_dyn_ops->(\w+)\(/g)) called.add(match[1]!);
  expect([...called].filter((entry) => !installed.includes(entry))).toEqual([]);
  expect([...called]).toEqual(expect.arrayContaining(["weak_get", "weak_test", "weak_set"]));
});

test("a unit has one build for every combination of the features its builds name", () => {
  // A program links one build of each unit: the one that carries the define
  // of every feature it has. Two features that each add a build column to
  // the same unit therefore need a build that carries both defines, also
  // when the columns were added by changes that did not know of each other.
  // A combination no program can have needs none: a feature that implies
  // another never comes without it. The matrix names those implications in
  // RUNTIME_FEATURE_IMPLIES when it has any; without the table every
  // combination is possible.
  const implies: Record<string, string[]> =
    Reflect.get(packMatrix, "RUNTIME_FEATURE_IMPLIES") ?? {};
  const withImplied = (feature: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(feature)) return seen;
    seen.add(feature);
    for (const need of implies[feature] ?? []) withImplied(need, seen);
    return seen;
  };
  for (const { source } of matrix.runtime_units as { source: string }[]) {
    const variants: { id: string; when: Record<string, boolean>; defines: string[] }[] =
      variantsFor(source);
    const named = (when: Record<string, boolean>): string =>
      Object.keys(when)
        .filter((name) => when[name])
        .sort()
        .join("+");
    const features = [...new Set(variants.flatMap((variant) => Object.keys(variant.when)))].sort();
    // A feature's own defines: those of the smallest build a program with
    // that feature can link, the one naming it and what it implies.
    const alone = (feature: string): string[] => {
      const smallest = [...withImplied(feature)].sort().join("+");
      return variants.find((variant) => named(variant.when) === smallest)?.defines ?? [];
    };
    for (let mask = 0; mask < 1 << features.length; mask++) {
      const on = features.filter((_, index) => (mask & (1 << index)) !== 0);
      const possible = on.every((name) => (implies[name] ?? []).every((need) => on.includes(need)));
      const builds = variants.filter((variant) => named(variant.when) === on.join("+"));
      expect(
        builds.map((variant) => variant.id),
        `${source} with ${on.join("+") || "no feature"}`,
      ).toHaveLength(possible ? 1 : 0);
      if (!possible) continue;
      expect([...builds[0]!.defines].sort(), `${source} with ${on.join("+")}`).toEqual(
        [...new Set(on.flatMap(alone))].sort(),
      );
    }
  }
});
