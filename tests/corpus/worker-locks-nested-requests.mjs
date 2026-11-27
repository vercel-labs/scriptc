// A lock callback that asks for the same name again queues behind itself;
// when the outer callback returns, the queued requests are granted one after
// another, several levels deep, and the lock manager must keep its bookkeeping
// valid across every grant.
import { locks } from "node:worker_threads";

const log = [];
locks.request("deep", (lock) => {
  log.push("one:" + lock.name + ":" + lock.mode);
  locks.request("deep", (second) => {
    log.push("two:" + second.name + ":" + second.mode);
    locks.request("deep", (third) => {
      log.push("three:" + third.name + ":" + third.mode);
      locks.request("deep", (fourth) => {
        log.push("four:" + fourth.name + ":" + fourth.mode);
        return "fourth";
      });
      return "third";
    });
    return "second";
  });
  return "first";
});
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(log.join(","));
console.log("held", (await locks.query()).held.length, "pending", (await locks.query()).pending.length);
