import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

const srcDir = join(import.meta.dirname, "../src");

// scr_stream_private.h repeats the stream unit's private state layout for the
// gated stdin stream unit, because the stream unit's own object must not
// change. A field added to one copy and not the other would move every field
// behind it for one of the two units, so the two texts must stay identical.
test("scr_stream_private.h repeats scr_stream.c's state layout line for line", async () => {
  const unit = await readFile(join(srcDir, "scr_stream.c"), "utf8");
  const header = await readFile(join(srcDir, "scr_stream_private.h"), "utf8");

  const first = "typedef struct ScrWEntry {\n";
  const stateStart = "\nstruct ScrStreamState {\n";
  const start = unit.indexOf(first);
  const state = unit.indexOf(stateStart, start);
  expect(start).toBeGreaterThan(-1);
  expect(state).toBeGreaterThan(start);
  const end = unit.indexOf("\n};\n", state);
  expect(end).toBeGreaterThan(state);
  const layout = unit.slice(start, end + "\n};\n".length);
  // One definition of each in the unit: the slice is the whole layout.
  expect(unit.split(first).length).toBe(2);
  expect(unit.split(stateStart).length).toBe(2);

  const begin = "/* scr_stream.c: state layout begin */\n";
  const close = "/* scr_stream.c: state layout end */\n";
  const from = header.indexOf(begin);
  const to = header.indexOf(close);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  expect(header.slice(from + begin.length, to)).toBe(layout);
});
