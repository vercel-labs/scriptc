import { createRequire } from "node:module";

// import.meta.resolve is scoped to each compiled module. Relative names are
// URLs even when the target does not exist; builtins canonicalize to node:;
// URL-like inputs normalize without touching the filesystem; installed bare
// packages resolve under Node's ESM import conditions.
console.log("relative", import.meta.resolve("./module with space.mjs"));
console.log("missing", import.meta.resolve("./missing.mjs"));
console.log("builtins", import.meta.resolve("fs"), import.meta.resolve("node:path"));
console.log("url", import.meta.resolve("https://example.com/a/../b"));
console.log("data", import.meta.resolve("data:text/javascript,export default 1"));
console.log("package", import.meta.resolve("typescript").endsWith("/typescript/lib/version.cjs"));
const require = createRequire(import.meta.url);
console.log("createRequire", require.resolve("./module with space.mjs"));
console.log("createRequire core paths", require.resolve.paths("fs"));
try {
  import.meta.resolve("definitely-not-installed-here");
  console.log("unexpected resolution");
} catch (error) {
  console.log("missing package", error.code, error.message.split("\n")[0]);
}
