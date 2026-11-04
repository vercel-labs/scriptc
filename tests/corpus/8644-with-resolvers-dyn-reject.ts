// Promise.withResolvers on a promise whose settled value is unknown: the
// resolver record's reject closure carries the program's own reason, the
// same stance the `new Promise` executor's reject takes, so a number, a
// string, a primitive or an object reaches the handlers unchanged and an
// Error stays one across `await`. A typed withResolvers keeps the Error
// channel, and first settle wins. The resolvers are also destructured.
async function settled(reason: any): Promise<string> {
  const resolvers = Promise.withResolvers();
  resolvers.reject(reason);
  try {
    await resolvers.promise;
    return "resolved";
  } catch (error: any) {
    return `${typeof error} ${error instanceof Error ? error.name + ":" + error.message : String(error)}`;
  }
}

async function main(): Promise<void> {
  console.log("number", await settled(42));
  console.log("string", await settled("s"));
  console.log("null", await settled(null));
  console.log("undefined", await settled(undefined));
  console.log("bool", await settled(false));
  console.log("error", await settled(new Error("boom")));
  console.log("range", await settled(new RangeError("out of range")));

  const payload = { answer: 42 };
  const identity = Promise.withResolvers();
  identity.promise.catch((error: any) => console.log("identity", error === payload));
  identity.reject(payload);

  const chained = Promise.withResolvers();
  const seen = chained.promise.then(
    () => "resolved",
    (error: any) => `rejected ${JSON.stringify(error)}`,
  );
  chained.reject({ code: 7 });
  console.log("then", await seen);

  const once = Promise.withResolvers();
  once.resolve("first");
  once.reject("ignored");
  once.reject("also ignored");
  console.log("settle once", await once.promise);

  const typed = Promise.withResolvers<string>();
  typed.reject(new Error("typed boom"));
  try {
    await typed.promise;
  } catch (error) {
    const asError = error as Error;
    console.log("typed", asError instanceof Error, asError.message);
  }

  const { promise, resolve, reject } = Promise.withResolvers();
  setTimeout(() => reject(7), 0);
  const destructured: any = await promise.then(
    () => "resolved",
    (error: any) => `rejected ${error}`,
  );
  console.log("destructured", destructured);
  console.log("done");
}

main();
