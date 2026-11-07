// Awaiting a rejected checked-dynamic promise re-throws its reason the way
// `throw reason` does. ECMAScript's rejection reason is the value the
// executor rejected with, so an Error reason reaches the awaiter as that
// %Error instance: a caught `error as Error` cast, `instanceof Error`,
// `.name` and `.message` all work, and the reference is the Error the
// program rejected with. A primitive reason arrives as the primitive and a
// plain object as the very object. The same holds for a for await loop's
// final synchronous step, for a then-created promise, and for an async
// function that throws a non-Error value. Node is the oracle byte-for-byte.
const rejectWith: any = (reason: unknown) =>
  new Promise((resolve, reject) => reject(reason));

function describe(value: unknown): string {
  return typeof value + " " + String(value);
}

async function main(): Promise<void> {
  // An Error reason is that Error after the await.
  const rejected = new Error("boom");
  try {
    await rejectWith(rejected);
    console.log("error missed");
  } catch (error) {
    const asError = error as Error;
    console.log(
      "error",
      asError instanceof Error,
      asError.name,
      asError.message,
      asError === rejected,
    );
  }

  // A subclass keeps its name, and String() reads the same halves.
  try {
    await rejectWith(new TypeError("bad type"));
  } catch (error) {
    const asError = error as Error;
    console.log("subclass", asError instanceof Error, asError.name, asError.message);
  }

  // A primitive reason is the primitive, not an Error built from it.
  const numberReason: any = 42;
  try {
    await rejectWith(numberReason);
  } catch (error) {
    console.log("number", describe(error), error === numberReason);
  }
  const stringReason: any = "text";
  try {
    await rejectWith(stringReason);
  } catch (error) {
    console.log("string", describe(error), error === stringReason);
  }
  const booleanReason: any = false;
  try {
    await rejectWith(booleanReason);
  } catch (error) {
    console.log("boolean", describe(error), error === booleanReason);
  }
  const nullReason: any = null;
  try {
    await rejectWith(nullReason);
  } catch (error) {
    console.log("null", describe(error), error === nullReason);
  }
  const undefinedReason: any = undefined;
  try {
    await rejectWith(undefinedReason);
  } catch (error) {
    console.log("undefined", describe(error), error === undefinedReason);
  }

  // A plain object reason is the very object.
  const objectReason: any = { tag: "identity" };
  try {
    await rejectWith(objectReason);
  } catch (error) {
    console.log("object", (error as any).tag, error === objectReason);
  }

  // The value a synchronous for await step promises in its done result.
  function finishing(last: () => any): any {
    return {
      [Symbol.iterator]() {
        let step = 0;
        return { next: () => (step++ < 1 ? { value: 1, done: false } : last()) };
      },
    };
  }
  async function loop(label: string, source: any): Promise<void> {
    try {
      for await (const value of source) console.log(label, "value", value);
      console.log(label, "completed");
    } catch (error) {
      console.log(label, "caught", (error as Error).name, (error as Error).message);
    }
  }
  await loop(
    "final error",
    finishing(() => ({ value: rejectWith(new Error("final boom")), done: true })),
  );
  await loop(
    "final step",
    finishing(() => ({ value: rejectWith(new RangeError("step boom")), done: false })),
  );

  // A then-created promise re-throws the same Error onward.
  try {
    await rejectWith(new Error("chained")).then((value: unknown) => value);
  } catch (error) {
    console.log("chained", (error as Error).name, (error as Error).message);
  }

  // An async function that throws a typed Error is unchanged (an object
  // exception, not a checked-dynamic one).
  async function boom(): Promise<void> {
    throw new SyntaxError("async boom");
  }
  try {
    await boom();
  } catch (error) {
    console.log("async", (error as Error).name, (error as Error).message);
  }
}

main().then(() => console.log("done"));
