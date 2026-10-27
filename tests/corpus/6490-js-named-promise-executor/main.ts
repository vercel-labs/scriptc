// A JavaScript library that builds its promise from a named executor
// function (`function run(resolve, reject) {...}; return new Promise(run)`,
// the classic retry helper shape): the executor's parameters are untyped,
// so it receives the native resolve and reject as checked-dynamic function
// values and calls them like any JavaScript function.
import { attempt } from "later";
async function main(): Promise<void> {
  const v = await attempt(async (_bail: (e: Error) => void, n: number): Promise<string> => {
    if (n < 3) throw new Error("try " + n);
    return "done after " + n;
  }, 5);
  console.log(v);
  try {
    await attempt((bail: (e: Error) => void): string => {
      bail(new Error("stop"));
      return "ignored";
    }, 5);
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}
main();
