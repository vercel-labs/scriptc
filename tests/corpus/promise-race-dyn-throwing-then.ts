// A dynamic race entry whose `then` read throws: Node's PromiseResolve
// rejects the promise it makes for the entry with the thrown value, so the
// race promise rejects and the catch below runs. A synchronous throw would
// escape the race call before the try.
const entry: unknown = JSON.parse("{}");
function explode(): never {
  throw new Error("then exploded");
}
Object.defineProperty(entry as object, "then", { get: explode });

const race = Promise.race([entry, Promise.resolve("other")]);

async function main(): Promise<void> {
  try {
    console.log("winner", await race);
  } catch (error) {
    console.log("rejected", (error as Error).message);
  }
}

main();
