// A Node island's function used as a value compiles where the program's slot
// has a function type the checked function boundary can adapt. Where it
// cannot (here a Promise executor, whose own parameters are functions, and a
// comparator that may be undefined), the refusal is SC8010 and names the
// function and the island: the package is not missing an implementation, it
// runs in the island.
import { compare, settle } from "ordkit";

const answer = new Promise<number>(settle);
answer.then((value) => console.log(value));

const reverse = process.argv.length > 99;
console.log(["b", "a"].sort(reverse ? undefined : compare).join(","));
