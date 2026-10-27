// TypeScript overrides returning Promise<void> over an untyped JavaScript
// async method: an async override and a promise-returning one.
import { Lock } from "./lock.js";
class TimedLock extends Lock {
  waits = 0;
  async acquire(): Promise<void> {
    this.waits++;
    await super.acquire();
    this.log.push("timed acquire");
  }
}
class EagerLock extends Lock {
  acquire(): Promise<void> {
    this.log.push("eager");
    return Promise.resolve();
  }
}
async function main(): Promise<void> {
  const locks: Lock[] = [new TimedLock(), new EagerLock(), new Lock()];
  for (const lock of locks) {
    await lock.acquire();
    console.log(lock.held, lock.log.join(","));
  }
  const timed = new TimedLock();
  await timed.acquire();
  console.log(timed.waits, timed.held);
  const viaBase: Lock = new TimedLock();
  console.log(await new Lock().acquire(), await viaBase.acquire());
}
main();
