// The project marks a TypeScript module to run in a Node island, but Node
// runs TypeScript by erasing types and the module declares an enum.
import { label, Level } from "./levels.ts";

console.log(label(Level.High));
