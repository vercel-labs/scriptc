// JavaScript's Promise.resolve over a checked-dynamic value that holds a
// promise (a TypeScript async callback's result handed back into a
// JavaScript library) answers that same promise — adopted, not wrapped —
// and wraps plain values.
import { sameAfterResolve, viaExecutor, viaResolve, viaThen } from "calls";

async function main(): Promise<void> {
  console.log(await viaResolve(async (): Promise<string> => "resolved"));
  console.log(await viaThen(async (): Promise<number> => 42));
  console.log(await viaExecutor(async (): Promise<string> => "executor"));
  console.log(await viaExecutor((): string => "plain"));
  try {
    await viaExecutor(async (): Promise<string> => {
      throw new Error("callback failed");
    });
  } catch (e) {
    console.log("caught:", (e as Error).message);
  }
  const pending = Promise.resolve("p");
  console.log(sameAfterResolve(pending), sameAfterResolve("p"));
}

main();
