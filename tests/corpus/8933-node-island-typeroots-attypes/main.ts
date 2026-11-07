// @requires-libnode
// A package that ships no declarations is typed by its `@types` package,
// which the tsconfig names in `types` (through `typeRoots`), so its
// declarations are a root of the program as well as the answer to each
// import. The package runs in a Node island, and `@types/<name>` declares
// the island's values exactly as declarations the package ships would.
import kit, { type PaintKit, type PaintResult } from "paint-kit";
import { bold, soft } from "paint-kit/tones";

function describe(result: PaintResult): string {
  return `${result.value} (${result.tone}, ${result.length})`;
}

kit.register("bold", bold);
const held: PaintKit = kit;
held.register("soft", soft);
console.log(describe(kit.paint("hi", { tone: "bold" })));
console.log(describe(held.paint("there", { tone: "soft" })));
console.log(held === kit, kit.has("bold"), kit.has("wide"), kit.list().join(","));
void import("paint-kit/full").then((mod) => {
  const full = mod.default;
  console.log(full === kit, full.has("soft"), describe(full.paint("x", { tone: "soft" })));
});
