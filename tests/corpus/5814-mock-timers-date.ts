// The module's mock.timers for Date, setImmediate and AbortSignal.timeout:
// a cache whose entries expire by Date.now(), a batch that flushes on
// setImmediate, a request deadline from AbortSignal.timeout, and
// enable() without options, which mocks every API.
import { mock } from "node:test";

class TtlCache {
  private entries = new Map<string, { value: string; expires: number }>();
  private ttl: number;
  constructor(ttl: number) {
    this.ttl = ttl;
  }
  set(key: string, value: string): void {
    this.entries.set(key, { value, expires: Date.now() + this.ttl });
  }
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() >= entry.expires) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
}

mock.timers.enable({ apis: ["Date"], now: new Date("2024-05-01T12:00:00Z") });
console.log(new Date().toISOString());
const cache = new TtlCache(60_000);
cache.set("user", "ada");
mock.timers.tick(59_999);
console.log(cache.get("user"));
mock.timers.tick(1);
console.log(cache.get("user"));
mock.timers.setTime(0);
console.log(Date.now(), new Date().toISOString());
mock.timers.reset();
console.log(Date.now() > 1_700_000_000_000);

const batches: string[][] = [];
let pending: string[] = [];
function queue(item: string): void {
  if (pending.length === 0) {
    setImmediate(() => {
      batches.push(pending);
      pending = [];
    });
  }
  pending.push(item);
}

mock.timers.enable({ apis: ["setImmediate"] });
queue("a");
queue("b");
mock.timers.tick(0);
console.log(JSON.stringify(batches));
queue("c");
queue("d");
console.log(JSON.stringify(pending));
mock.timers.tick(0);
console.log(JSON.stringify(batches));
const skipped = setImmediate(() => console.log("never"));
clearImmediate(skipped);
console.log(skipped.hasRef());
mock.timers.runAll();
mock.timers.reset();

mock.timers.enable();
const deadline = AbortSignal.timeout(5_000);
deadline.addEventListener("abort", () => {
  const reason = deadline.reason as { name: string; message: string };
  console.log(`aborted at ${Date.now()}: ${reason.name}: ${reason.message}`);
});
mock.timers.tick(4_999);
console.log(deadline.aborted);
mock.timers.tick(1);
console.log(deadline.aborted);
mock.timers.reset();

const real = AbortSignal.timeout(1);
real.addEventListener("abort", () => {
  console.log(`real deadline: ${(real.reason as { name: string }).name}`);
});
