// import() with a second argument asks for import attributes, which this
// build does not honour: the refusal is the compiler's own early error for
// every specifier shape, including a bounded nonconstant value that would
// otherwise lower through the run-time selector.
function load(name: string): Promise<unknown> {
  return import(name, { with: { type: "json" } });
}

async function main(): Promise<void> {
  await import("node:path", { with: { type: "json" } });
  await load("node:path");
}

main();
