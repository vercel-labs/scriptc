import { expect, test } from "vitest";
import { createRuntimePackMatrix } from "../runtime-pack-matrix.mjs";

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

test("the BigIntStats unit follows its own member-read gate, not bigint", () => {
  const unit = matrix.runtime_units.find(
    (u: { source: string }) => u.source === "scr_stats_bigint.c",
  );
  // Every bigint value turns the bigint feature on; only the member reads
  // name bigstats, so a bigint program keeps this unit out of its binary.
  expect(unit.predicate).toBe("bigstats");
});

test("an array defineProperty build carries every feature the program also needs", () => {
  const plain = {
    workers: false,
    dynTier: false,
    nodeIsland: false,
    webStreams: false,
    recordViewPartial: false,
    dynArrayAttrs: false,
  };
  // The per-element attribute bits select their own build of the dynamic
  // tree, alone...
  expect(selected("scr_json.c", { ...plain, dynArrayAttrs: true }).defines).toEqual([
    "SCR_ARRAY_ATTRS",
  ]);
  // ...and beside each feature that already has a build of the unit.
  expect(
    selected("scr_json.c", { ...plain, dynArrayAttrs: true, recordViewPartial: true }).defines,
  ).toEqual(["SCR_RECORD_VIEW_PARTIAL", "SCR_ARRAY_ATTRS"]);
  expect(
    selected("scr_json.c", {
      ...plain,
      dynArrayAttrs: true,
      dynTier: true,
      nodeIsland: true,
      webStreams: true,
    }).defines,
  ).toEqual(["SCR_JS_TIER", "SCR_HANDLE_CLASSES", "SCR_NODE_ISLANDS", "SCR_ARRAY_ATTRS"]);
  // A program that never defines an array element keeps the default object,
  // byte for byte.
  expect(selected("scr_json.c", plain).defines).toEqual([]);
  expect(selected("scr_json.c", { ...plain, nodeIsland: true }).defines).toEqual([
    "SCR_NODE_ISLANDS",
  ]);
  // scr_dyn_invoke.c has one build of its own for the same feature.
  expect(selected("scr_dyn_invoke.c", { ...plain, dynArrayAttrs: true }).defines).toEqual([
    "SCR_ARRAY_ATTRS",
  ]);
  expect(selected("scr_dyn_invoke.c", plain).defines).toEqual([]);
});
