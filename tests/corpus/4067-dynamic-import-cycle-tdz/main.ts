// @dynamic
// import() of a module whose cycle partner reads a const of it at top
// level: the partner evaluates first, its read throws ReferenceError, and
// the import() promise rejects with that error.
async function main(): Promise<void> {
  try {
    const ns = await import("./a.ts");
    console.log("loaded", ns.label());
  } catch (e) {
    const err = e as Error;
    console.log("rejected:", err.name, err.message);
  }
}
main();
