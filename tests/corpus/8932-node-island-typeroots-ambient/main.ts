// @requires-libnode
// A package that ships no declarations is typed by the project's typings
// directory (`typeRoots` and `types` in the tsconfig), whose `declare module`
// blocks declare the package's interfaces. The package runs in a Node
// island, so those interfaces are the island's: a value of one is the island
// object wherever the program holds it, in a binding, a parameter or a
// result, and a native object typed by one is made for the island.
import kit, { type PaintKit, type PaintResult, type PaintTone } from "paint-kit/lib/core.js";
import bold from "paint-kit/lib/tones/bold.js";
import soft from "paint-kit/lib/tones/soft.js";

const held: PaintKit = kit;
function paintWith(api: PaintKit, text: string, tone: string): PaintResult {
  return api.paint(text, { tone });
}
function describe(result: PaintResult): string {
  return `${result.value} (${result.tone}, ${result.length})`;
}
const plain: PaintTone = { open: "(", close: ")" };

kit.register("bold", bold);
held.register("soft", soft);
held.register("plain", () => plain);
console.log(describe(paintWith(kit, "hi", "bold")));
console.log(describe(paintWith(held, "there", "soft")));
console.log(describe(held.paint("p", { tone: "plain" })), plain.open, plain.close);
const found: PaintTone | undefined = held.tone("soft");
console.log(found !== undefined, found?.open, held.tone("wide") === undefined, held.tone("plain")?.close);
console.log(held === kit, kit.has("bold"), held.has("wide"), kit.list().join(","));
void import("paint-kit/lib/index.js").then((mod) => {
  const full: PaintKit = mod.default;
  console.log(full === kit, full.has("wide"), describe(paintWith(full, "x", "wide")), full.list().join(","));
});
