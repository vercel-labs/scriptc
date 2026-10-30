// A computed import.meta.resolve() whose specifier the build can bound
// (SPEC §5.5): the selector folds each value the site can pass through the
// literal site's own runtime resolver, and the default arm never runs.
function resolved(specifier) {
  return import.meta.resolve(specifier);
}

console.log("builtin", resolved("fs"), resolved("node:path"));
console.log("relative", resolved("./module with space.mjs"));
console.log("url", resolved("https://example.com/a/../b"));
console.log("package", resolved("typescript").endsWith("/typescript/lib/typescript.js"));

// A bound const: the same values through a second site.
const which = "node:os";
console.log("const", resolved(which));

// A specifier that resolves to nothing throws where it is resolved.
try {
  resolved("definitely-not-installed-here");
  console.log("unexpected resolution");
} catch (error) {
  console.log("missing package", error.code, error.message.split("\n")[0]);
}
