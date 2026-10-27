// Polyfill packages whose module IS a Node builtin on Node 24, installed as
// their published releases: isarray (Array.isArray), safe-buffer (buffer),
// process-nextick-args (process), inherits (util.inherits) and
// util-deprecate (util.deprecate) compile as the builtins.
import { encode, kinds, later, oldArea, square } from "gtpolyfills";

console.log(kinds([[1], "a", 2, [], { length: 0 }]));
console.log(encode("héllo"));
console.log(square(4));
console.log(oldArea(3));
later("tick", (message) => console.log(message));
console.log("sync done");
