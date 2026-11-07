import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DYN_HANDLE_KINDS } from "../../ir/ir.js";
import { ISLAND_EXPORTED_HANDLE_TAGS } from "./lower-node-island.js";

// The runtime decides which native values the island export table holds:
// scr_ni_exportable (scr_node_island_export.c). A native value outside it
// dies at the crossing with "this native object cannot cross into a Node
// island yet", so the compiler refuses a statically typed I/O handle by
// name (SC8010, unexportedNative). The runtime function is the source of
// truth: this reads it, so the compiler's list cannot drift from it.
const source = readFileSync(
  new URL("../../../../runtime/src/scr_node_island_export.c", import.meta.url),
  "utf8",
);
const body = /\nbool scr_ni_exportable\(const ScrDyn \*v\) \{\n([\s\S]*?)\n\}\n/.exec(source)![1]!;

test("the handle tags the runtime exports are the ones the compiler lets cross", () => {
  const tags = [...body.matchAll(/v->v\.handle\.tag == (SCR_DYNH_[A-Z0-9_]+)/g)].map(
    ([, tag]) => tag!,
  );
  expect(tags.length).toBeGreaterThan(0);
  expect(tags.sort()).toEqual([...ISLAND_EXPORTED_HANDLE_TAGS].sort());
});

test("no I/O handle kind is exported, so each is refused at build time", () => {
  // A handle kind the runtime starts to export joins ISLAND_EXPORTED_HANDLE_TAGS
  // (the test above asks for it) and stops being refused; until then every
  // kind of DYN_HANDLE_KINDS is one the crossing refuses.
  const exported = [...DYN_HANDLE_KINDS.values()].filter(({ tag }) =>
    ISLAND_EXPORTED_HANDLE_TAGS.has(tag),
  );
  expect(exported).toEqual([]);
});

test("the runtime exports the checked-dynamic kinds the island lowering relies on", () => {
  const kinds = [...body.matchAll(/case (SCR_DYN_[A-Z_]+):/g)].map(([, kind]) => kind);
  expect(kinds).toEqual([
    "SCR_DYN_FUNC",
    "SCR_DYN_PROMISE",
    "SCR_DYN_OBJ",
    "SCR_DYN_ARR",
    "SCR_DYN_TYPED_REF",
    "SCR_DYN_HANDLE",
  ]);
});
