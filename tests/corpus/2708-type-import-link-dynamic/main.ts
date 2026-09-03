// @dynamic
// @exit: 0
// A missing type-only export in a dynamic child rejects import() at link time,
// before the child or its dependency evaluates.
try {
  await import("./child.ts");
  console.log("unexpected");
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
}
