// for await and async yield* over values held as any: a Symbol.asyncIterator
// method that returns a compiled generator, a synchronous delegate whose
// final value is a promise, a synchronous iterator whose final value throws
// or rejects, and return() results that are not objects.
const settle: any = (value: unknown, fails: boolean) =>
  new Promise((resolve, reject) => (fails ? reject(new Error(String(value))) : resolve(value)));
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
    console.log(label, "caught", (error as Error).message);
  }
}
async function main(): Promise<void> {
  const generated: any = {
    async *[Symbol.asyncIterator]() {
      yield "a";
      yield "b";
    },
  };
  for await (const value of generated) console.log("generated", value);

  const syncGenerated: any = {
    *[Symbol.iterator]() {
      yield "x";
      yield "y";
    },
  };
  for await (const value of syncGenerated) console.log("sync generated", value);

  function* inner(): Generator<number, Promise<string>> {
    yield 1;
    return Promise.resolve("done");
  }
  async function* outer(): AsyncGenerator<number, void> {
    const result = yield* inner();
    console.log("delegate result", result);
  }
  for await (const value of outer()) console.log("delegated", value);

  const primitiveReturn: any = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: 1, done: false }),
        return: async () => 5,
      };
    },
  };
  try {
    for await (const value of primitiveReturn) {
      console.log("before break", value);
      break;
    }
    console.log("no error");
  } catch (error) {
    console.log("break", (error as Error).name, (error as Error).message);
  }

  async function* wrapper(): AsyncGenerator<unknown, void> {
    yield* primitiveReturn;
  }
  const it = wrapper();
  console.log("first", await it.next());
  try {
    console.log("returned", await it.return());
  } catch (error) {
    console.log("return", (error as Error).name, (error as Error).message);
  }

  await loop("getter", finishing(() => ({ done: true, get value(): number { throw new Error("value getter"); } })));
  await loop("rejected", finishing(() => ({ value: settle("rejected final", true), done: true })));
  await loop("resolved", finishing(() => ({ value: settle(9, false), done: true })));
  await loop("rejected step", finishing(() => ({ value: settle("rejected step", true), done: false })));
  async function* finalRejects(): AsyncGenerator<unknown, void> {
    const result = yield* finishing(() => ({ value: settle("delegate final", true), done: true }));
    console.log("delegate completed", result);
  }
  try {
    for await (const value of finalRejects()) console.log("delegate value", value);
  } catch (error) {
    console.log("delegate caught", (error as Error).message);
  }
}
main();
