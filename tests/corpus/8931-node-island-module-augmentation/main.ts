// @requires-libnode
// A project augments an interface of a package that runs in a Node island,
// once in a declaration file its tsconfig includes and once in a module of
// its own. The interface stays the island's: its values are island objects
// in bindings, parameters and results, and the added members are called
// through the island like the ones the package declares.
import kit, { type PaintKit } from "paint-kit";
import { bold, soft } from "paint-kit/tones";

declare module "paint-kit" {
  interface PaintKit {
    clear(): void;
  }
}

function census(api: PaintKit): string {
  return `${api.count()}: ${api.list().join(",")}`;
}

kit.register("bold", bold);
console.log(kit.paint("hi", { tone: "bold" }).value);
console.log(kit.has("bold"), kit.has("soft"), kit.count());
const held: PaintKit = kit;
held.register("soft", soft);
console.log(census(held), held === kit);
void import("paint-kit/full").then((mod) => {
  const full = mod.default;
  console.log(full === kit, census(full), full.paint("x", { tone: "soft" }).value);
  full.clear();
  console.log(census(kit), kit.has("bold"));
});
