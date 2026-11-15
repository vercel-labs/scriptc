// A Node island loads a module of the program through a bounded import()
// (SPEC §5.1, §5.3): the island scan reads the values of a syntactically
// bounded argument, so the module it names is provided to the island and
// both sides write the one native instance.
import { requireModule } from "@scriptc/node";

interface Dyn {
  note(entry: string): number;
  entries(): string;
}

async function main(): Promise<void> {
  const dyn = (await import("./bounded" + "-dyn.mjs")) as Dyn;
  console.log("main", dyn.note("main-1"), JSON.stringify(dyn.entries()));
  const plugin = requireModule("./bounded-plugin.mjs");
  console.log("island", await plugin.loadDyn());
  console.log("main after", dyn.entries() === "main-1,island-dyn", JSON.stringify(dyn.entries()));
  console.log("island again", await plugin.loadDyn());
  console.log("main end", JSON.stringify(dyn.entries()));
}
void main();
