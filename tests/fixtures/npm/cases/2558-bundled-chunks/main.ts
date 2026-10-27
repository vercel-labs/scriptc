// esbuild's bundled CommonJS chunks: each package below is real esbuild
// output (0.25 unminified, 0.25 whitespace+syntax minified, 0.17) of one
// source that bundles CommonJS modules through the __commonJS helper.
// Every chunk compiles as its own CommonJS module: it runs once, at its
// first require (the top-level interop imports run while the bundle
// loads; `lazy` requires its chunk only when called), chunk-to-chunk
// requires share one module instance, an esbuild-built dist bundled as a
// chunk keeps its suffixed helpers, and the external dependency passes
// through the __toESM interop. gtcjsdist is a "type": "module" package
// whose CommonJS entry is a .cjs bundle using the node-mode interop.
import { describe, external, lazy, nested } from "gtchunk";
import { describe as dws, external as ews, lazy as lws, nested as nws } from "gtchunkws";
import { describe as d17, external as e17, lazy as l17, nested as n17 } from "gtchunk17";
import { viaNodeMode } from "gtcjsdist";

console.log("main start");
console.log("plain", describe());
console.log("plain", external());
console.log("plain", nested());
console.log("plain", lazy(), lazy());
console.log("minified", dws());
console.log("minified", ews());
console.log("minified", nws());
console.log("minified", lws(), lws());
console.log("older", d17());
console.log("older", e17());
console.log("older", n17());
console.log("older", l17(), l17());
console.log(viaNodeMode());
