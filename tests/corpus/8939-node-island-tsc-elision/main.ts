// @requires-libnode
// @tsc-emit
// A project that does not set `verbatimModuleSyntax` imports a package that
// runs in a Node island. tsc drops the imports the program never uses as
// values, so the island module they name is never loaded: the types named
// without `type` bind nothing, and the module whose only import is unused
// does not run. The imports that remain are island values.
import kit, { PaintKit, PaintResult } from "paint-kit";
import { bold, soft, Tone } from "paint-kit/tones";
import { Loud, shout, volume } from "paint-kit/loud";

const quiet: Loud = { level: 1 };
const wide: Tone = { open: "[[", close: "]]" };
function describe(result: PaintResult): string {
  return `${result.value} (${result.tone}, ${result.length})`;
}
function census(api: PaintKit): string {
  return api.list().join(",");
}

kit.register("bold", bold);
kit.register("wide", () => wide);
console.log(describe(kit.paint("hi", { tone: "bold" })));
console.log(describe(kit.paint("there", { tone: "wide" })));
console.log(census(kit), quiet.level, typeof soft);
