// A createRequire loader held as a value is a run-time require function
// with none of the properties Node's require carries. Reading `resolve`,
// `cache`, `main` or `extensions` through the holder builds: the statement
// throws its refusal when it runs, and the build names it with a warning.
// A call the compiler can see with a computed name stays refused where it
// is written, which is the one error here.
import { createRequire } from "node:module";

const narrate = createRequire(import.meta.url);
const guide = { narrate };
const room = "crypt" + String(process.argv.length);
console.log(typeof guide.narrate.cache);
console.log(guide.narrate.resolve("./narration-" + room + ".js"));
console.log(guide.narrate.main === undefined);
console.log(narrate("./narration-" + room + ".js"));
