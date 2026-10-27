// An entry argument that throws synchronously leaves earlier rejections
// unhandled, since Promise.all never runs.
async function fail(tag: string): Promise<number> {
  throw new Error(`boom ${tag}`);
}
async function value(n: number): Promise<number> {
  return n;
}
function boom(): number {
  throw new Error("argument");
}
async function run(): Promise<void> {
  try {
    const r: number[] = await Promise.all([fail("first"), value(boom())]);
    console.log("resolved", r.length);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}
process.on("unhandledRejection", (reason) => console.log("unhandled", (reason as Error).message));
void run().then(() => console.log("done"));
