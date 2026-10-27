// A workspace package the program loads on demand with a dynamic import: its
// own npm dependency (installed only in the workspace package's
// node_modules) compiles with it, although neither is part of the startup
// module graph. A comment can stand between `import` and its parenthesis.
async function main(): Promise<void> {
  console.log("before");
  const m = await import /* loaded on demand */ ("wsdynamic");
  console.log(m.greet("world"));
}
main();
