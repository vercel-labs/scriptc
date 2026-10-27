// A workspace package the program loads on demand with a dynamic import.
// Its npm dependency is compiled CommonJS that requires a sibling scoped
// package (shipping JavaScript and declarations) from a nested file. Both
// packages compile with the workspace package, although none of them is
// part of the startup module graph.
async function main(): Promise<void> {
  console.log("before");
  const m = await import("wsdynamicdeps");
  console.log(m.describe("42"));
  console.log(m.describe("name"));
}
main();
