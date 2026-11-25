// @exit: 3
// The promise `catch` returns rejects when its handler value throws or
// returns a rejected promise; an 'unhandledRejection' listener observes
// each of them, in order, with the handler's own reason.
function failing(message: string): Promise<void> {
  return new Promise<void>((_resolve, reject) => reject(new Error(message)));
}
function rethrow(e: unknown): never {
  throw new Error("thrown again: " + (e as Error).message);
}
const rejectAgain = (e: unknown): Promise<void> =>
  Promise.reject(new Error("rejected again: " + (e as Error).message));
async function asyncRethrow(e: unknown): Promise<void> {
  await null;
  throw new Error("async again: " + (e as Error).message);
}
const handled = (e: unknown): void => {
  console.log("handled", (e as Error).message);
};

let seen = 0;
process.on("unhandledRejection", (reason) => {
  seen++;
  console.log("unhandled", seen, reason instanceof Error ? reason.message : String(reason));
  process.exitCode = 3;
});
process.on("exit", (code) => console.log("exit listener, code", code, "unhandled", seen));

failing("one").catch(rethrow);
failing("two").catch(rejectAgain);
failing("three").catch(asyncRethrow);
failing("four").catch(handled);
failing("five").catch(rethrow).catch(handled);
