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

test("a file read whose bytes the program can observe selects the branded build", () => {
  const plain = { workers: false, watchFile: false, fsBufferBrand: false };
  // Alone, the brand selects its own build.
  expect(selected("scr_lib.c", { ...plain, fsBufferBrand: true }).defines).toEqual([
    "SCR_FS_BUFFER_BRAND",
  ]);
  // Beside the poll it keeps both units' entry points.
  expect(selected("scr_lib.c", { ...plain, watchFile: true, fsBufferBrand: true }).defines).toEqual(
    ["SCR_FS_WATCH_FILE", "SCR_FS_BUFFER_BRAND"],
  );
  expect(selected("scr_lib.c", { ...plain, workers: true, fsBufferBrand: true }).defines).toEqual([
    "SCR_FS_BUFFER_BRAND",
    "SCR_WORKERS",
  ]);
  // A program that reads bytes without observing the brand keeps the default
  // object, byte for byte.
  expect(selected("scr_lib.c", plain).defines).toEqual([]);
  expect(selected("scr_lib.c", { ...plain, watchFile: true }).defines).toEqual([
    "SCR_FS_WATCH_FILE",
  ]);
});

test("every scr_json build has a JavaScript object model twin", () => {
  // The JavaScript object model build (t262-da §J) is one column for every
  // runtime feature only a JavaScript source reaches: each scr_json.c build
  // gets one twin, so any combination of features selects a build that
  // carries the object model's code.
  const variants = variantsFor("scr_json.c");
  expect(variants.map((variant: { id: string }) => variant.id)).toEqual([
    "default",
    "record-view-partial",
    "js-om",
    "js-om-record-view-partial",
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
  // ...keeps the record-view twin beside a partial record assertion...
  const partial = { workers: false, jsObjectModel: true, recordViewPartial: true };
  expect(selected("scr_json.c", partial).id).toBe("js-om-record-view-partial");
  expect(selected("scr_json.c", partial).defines).toEqual([
    "SCR_RECORD_VIEW_PARTIAL",
    "SCR_JS_OBJECT_MODEL",
  ]);
  // ...and keeps the worker build when the program starts threads.
  expect(selected("scr_json.c", { workers: true, jsObjectModel: true }).defines).toEqual([
    "SCR_JS_OBJECT_MODEL",
    "SCR_WORKERS",
  ]);
  // A program that reaches none of the features keeps the default object.
  expect(selected("scr_json.c", { workers: false }).id).toBe("default");
  expect(selected("scr_json.c", { workers: false }).defines).toEqual([]);
  expect(selected("scr_json.c", { workers: false, recordViewPartial: true }).defines).toEqual([
    "SCR_RECORD_VIEW_PARTIAL",
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
