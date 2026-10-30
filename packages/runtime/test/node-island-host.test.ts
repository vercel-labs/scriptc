import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderHeader } from "../../../scripts/node-island-host.mjs";

const srcDir = join(import.meta.dirname, "../src");

// scr_node_island.c starts `node -e` with the host embedded in this header;
// a host edit without regenerating it would ship the old host.
test("the embedded Node island host matches its source", () => {
  const source = `${readFileSync(join(srcDir, "scr_node_island_host.cjs"), "utf8")}\n${readFileSync(join(srcDir, "scr_node_island_hooks.cjs"), "utf8")}`;
  expect(readFileSync(join(srcDir, "scr_node_island_host.h"), "utf8")).toBe(renderHeader(source));
});
