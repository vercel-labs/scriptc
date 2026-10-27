// esbuild-bundled polyfill packages: __commonJS chunks whose keys name
// isarray, safe-buffer, process-nextick-args, inherits, util-deprecate and
// readable-stream 2.x at their versions compile as the Node builtins the
// modules are on Node 24 (readable-stream as its READABLE_STREAM=disable
// behavior: the Node side of this case runs with that variable set).
import { encode, kinds, later, oldArea, shout, square } from "gtpolybundle";

console.log(kinds([[1], "a", 2, []]));
console.log(encode("héllo"));
console.log(square(4));
console.log(oldArea(3));
later("tick", (message) => console.log(message));
shout(["a", "bc"], (result) => console.log(result));
console.log("sync done");
