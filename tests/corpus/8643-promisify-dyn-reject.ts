// util.promisify over a typed, callback-last function whose callback value is
// untyped: the promisified promise's settled value is checked-dynamic, but the
// reject closure the lowering builds is still the Error-taking one, because
// the promise rejects with the callback's own error. The dyn-reject closure a
// user-written `new Promise` gets must not be substituted here — its reason
// representation is a dyn payload, and handing it the `%Error` the callback
// passes would store an object as a dyn value.
import { promisify } from "node:util";

type Callback = (error: Error | null, value: any) => void;

function readThing(callback: Callback): void {
  setTimeout(() => callback(null, { answer: 42 }), 0);
}

function failThing(callback: Callback): void {
  setTimeout(() => callback(new Error("boom"), undefined), 0);
}

function failRange(callback: Callback): void {
  setImmediate(() => callback(new RangeError("out of range"), undefined));
}

function emitPrimitive(text: string, callback: Callback): void {
  setImmediate(() => callback(null, text.length));
}

const read = promisify(readThing);
const fail = promisify(failThing);
const failWithRange = promisify(failRange);
const emit = promisify(emitPrimitive);

async function main(): Promise<void> {
  const value: any = await read();
  console.log("value", value.answer, typeof value);

  try {
    await fail();
    console.log("no rejection");
  } catch (error) {
    const asError = error as Error;
    console.log("error", asError instanceof Error, asError.name, asError.message);
  }

  try {
    await failWithRange();
  } catch (error) {
    const asError = error as Error;
    console.log("range", asError instanceof RangeError, asError.message);
  }

  console.log("primitive", await emit("abcd"), typeof (await emit("x")));

  fail().catch((error: any) => console.log("chained", (error as Error).message));
  const settled: any = await fail().then(
    () => "resolved",
    (error: any) => `rejected ${(error as Error).message}`,
  );
  console.log("then", settled);
  console.log("done");
}

main();
