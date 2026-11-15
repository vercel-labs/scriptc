// @requires-libnode
// A project with a tsconfig and its own ambient declarations imports a
// package that runs in a Node island and ships its own types: the default
// export, named exports, the namespace, and the package's types on native
// bindings and parameters are all typed by the package's declarations, and
// their values are island values.
import kit, { type PaintKit, type PaintResult, type Tone } from "paint-kit";
import { bold, soft } from "paint-kit/tones";
import * as tones from "paint-kit/tones";

const wide: Tone = { open: "[[", close: "]]" };
function widen(api: PaintKit): Tone {
  return api.has("bold") ? wide : { open: "<", close: ">" };
}
function show(result: PaintResult, item: Labelled): string {
  return `${item.label}: ${result.value} (${result.tone}, ${result.length})`;
}

kit.register("bold", bold);
kit.register("soft", tones.soft);
kit.register("wide", widen);
const held: PaintKit = kit;
console.log(show(held.paint("a", { tone: "bold" }), { label: "one" }));
console.log(show(kit.paint("bc", { tone: "soft" }), { label: "two" }));
console.log(show(kit.paint("d", { tone: "wide" }), { label: "three" }));
console.log(held === kit, soft === tones.soft, kit.list().join(","));
console.log(wide.open, wide.close, Object.keys(tones).sort().join(","));
void import("paint-kit/full").then((mod) => {
  const full = mod.default;
  console.log(full === kit, full.has("soft"), show(full.paint("x", { tone: "soft" }), { label: "four" }));
});
