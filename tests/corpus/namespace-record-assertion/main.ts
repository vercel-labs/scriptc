// A program module's namespace asserted to a record: the assertion claims
// members the namespace exports, and Node hands back the namespace object
// itself, so a static namespace and an import() of the same module both
// answer the claimed shape.
import * as ns from "./mod.ts";

interface Dyn {
  note(entry: string): number;
  entries(): string;
}

async function main(): Promise<void> {
  const declared = ns as Dyn;
  console.log("static", declared.note("static"), JSON.stringify(declared.entries()));
  const literal = (await import("./mod.ts")) as Dyn;
  console.log("literal", literal.note("literal"), JSON.stringify(literal.entries()));
  const folded = (await import("./mod" + ".ts")) as Dyn;
  console.log("folded", folded.note("folded"), JSON.stringify(folded.entries()));
  console.log("shared", declared.entries() === ns.entries(), ns.hits);
}

void main();
