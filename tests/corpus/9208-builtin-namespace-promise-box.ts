// A builtin's module-namespace promise widened to Promise<unknown> settles
// exactly as the import does: the namespace object on fulfilment, the
// import's own error on rejection. The widening reads no member of the
// awaited value (a builtin box comes from the lowering tables), so it has
// to keep awaiting.
function failing(): Promise<typeof import("node:path")> {
  return Promise.reject(new Error("boom"));
}

async function main(): Promise<void> {
  const widened: Promise<unknown> = import("node:path");
  const boxed = await widened;
  console.log("call", (boxed as typeof import("node:path")).basename("a/b.txt"));
  try {
    await failing();
    console.log("fulfilled");
  } catch (error) {
    console.log("rejected", (error as Error).message);
  }
  const untyped: unknown = failing();
  try {
    await untyped;
    console.log("fulfilled untyped");
  } catch (error) {
    console.log("rejected untyped", (error as Error).message);
  }
}

main();
