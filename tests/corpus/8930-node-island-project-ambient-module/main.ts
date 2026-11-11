// @requires-libnode
// A project's own declaration file types a package that ships no
// declarations: global interfaces, and `declare module` blocks that export
// values of them. The package runs in a Node island, so what those blocks
// declare are island values: the default export is read through the island
// at each use, whatever interface the project names for it, and the dynamic
// import's namespace is the island module's.
import kit from "paint-kit/lib/core.js";
import bold from "paint-kit/lib/tones/bold.js";
import soft from "paint-kit/lib/tones/soft.js";

kit.register("bold", bold);
kit.register("soft", soft);
console.log(kit.paint("hi", { tone: "bold" }).value);
console.log(kit.has("bold"), kit.has("wide"), kit.list().join(","));
// A result typed by one of the project's global interfaces is read, or
// compared with undefined, where the island hands it over: the object
// itself stays in the island.
console.log(kit.paint("there", { tone: "soft" }).tone, kit.paint("there", { tone: "soft" }).length);
console.log(kit.tone("soft") !== undefined, kit.tone("wide") === undefined, kit.tone("bold")?.open);
try {
  kit.paint("lost", { tone: "wide" });
} catch (e) {
  console.log(e instanceof Error ? e.message : "not an error");
}
void import("paint-kit/lib/index.js").then(
  (mod) => {
    const full = mod.default;
    console.log(full.has("wide"), full.paint("x", { tone: "wide" }).value, full.list().join(","));
    console.log(kit.has("wide"), kit.paint("same", { tone: "wide" }).value);
  },
  () => console.log("not loaded"),
);
