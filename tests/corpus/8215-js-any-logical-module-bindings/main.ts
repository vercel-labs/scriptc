// Module bindings of a JavaScript package whose initializers combine an
// untyped value with a string, number or boolean through `||`, `&&`, `??`
// or `?:` (pi-coding-agent's config.js): other modules and functions read
// the values as in Node.
import { banner, usage } from "app-config";

console.log(banner);
console.log(usage("check"));
