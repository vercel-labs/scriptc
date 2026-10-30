// An identifier-minified esbuild CommonJS bundle (lru-cache's shape): its
// __commonJS helper and chunk parameters lost their names, the chunks
// stamp __esModule with { value: !0 }, and they call node:util and
// node:diagnostics_channel functions in the (0, ns.member)(...) form.
import { Cache } from "gtminicache";

const cache = new Cache<string, number>(2);
cache.set("a", 1).set("b", 2);
cache.get("a");
cache.set("c", 3);
console.log(cache.keys().join(","), cache.get("b"), cache.get("c"));
console.log(cache.describe("cache"));
