// @exit: 1
// A rejection from an await-free (fiberless) async function that nothing
// handles enters the unhandled-rejection ledger like any other: the
// checkpoint after the synchronous body reports it, so later timers never
// run and the process exits 1. A handled sibling stays quiet.
async function fails(message: string): Promise<number> {
  throw new Error(message);
}
async function main(): Promise<void> {
  fails("handled").catch((e: unknown) => console.log("handled", e instanceof Error ? e.message : e));
  console.log("before unhandled");
  void fails("nobody listens");
  console.log("after unhandled");
}
main();
setTimeout(() => console.log("timer must not run"), 0);
console.log("sync end");
