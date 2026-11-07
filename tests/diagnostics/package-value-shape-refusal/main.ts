// A types-only package's VALUE shape has no implementation in the compiled
// module graph: `new ValueThing()` would call a constructor that does not
// exist, so the class keeps its package refusal. The data shapes beside it
// (interfaces and type aliases the program itself builds) erase instead.
import { ValueThing } from "value-pkg";

const thing = new ValueThing();
console.log(thing.render());
