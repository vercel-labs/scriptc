// A dynamic import of a shipped .mjs whose types come from a sibling .d.mts:
// the runtime module is the JS file Node loads, so the import resolves to it
// and the namespace answers the default and named exports. Node is the oracle.
const mod = await import("./greeter.mjs");
const greet = mod.default;
console.log(greet("world"));
console.log("version:", mod.version, "typeof:", typeof greet);
