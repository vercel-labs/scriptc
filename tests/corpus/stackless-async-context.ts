// AsyncLocalStorage across stackless async bodies: a call inherits the
// caller's context when it starts, keeps it across every await even after
// the caller's run() window closed, nested runs inside the body shadow and
// restore around awaits, enterWith inside a body stays inside that body,
// and concurrent bodies keep their own contexts while their continuations
// interleave on the microtask queue and across timers. The concurrent
// bodies wake from gates that chained timer callbacks open one per turn in
// a fixed order, so their interleaving never depends on timer deadlines.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();
const log: string[] = [];
const say = (s: string): void => {
  log.push(s);
};
const current = (): string => store.getStore() ?? "none";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const opens: (() => void)[] = [];
function gate(): Promise<void> {
  return new Promise<void>((resolve) => {
    opens.push(resolve);
  });
}

// Opens the gates in `order`, each from its own timer callback scheduled by
// the previous one, so each woken body runs before the next gate opens.
function openInOrder(order: number[], at: number): void {
  if (at === order.length) return;
  setTimeout(() => {
    say("open gate " + order[at]!);
    opens[order[at]!]!();
    openInOrder(order, at + 1);
  }, 1);
}

async function worker(id: number, ready: Promise<void>): Promise<string> {
  say("worker " + id + " start " + current());
  await null;
  say("worker " + id + " after hop " + current());
  await ready;
  say("worker " + id + " after timer " + current());
  const inner = await store.run("inner" + id, async () => {
    await null;
    return current();
  });
  say("worker " + id + " inner " + inner + " back " + current());
  return current();
}

async function entering(): Promise<string> {
  say("entering start " + current());
  store.enterWith("entered");
  await Promise.resolve();
  say("entering after await " + current());
  return current();
}

async function main(): Promise<void> {
  const a = store.run("a", () => worker(1, gate()));
  const b = store.run("b", () => worker(2, gate()));
  const c = worker(3, gate());
  say("main after spawns " + current());
  openInOrder([1, 2, 0], 0);
  const all: Promise<string>[] = [a, b, c];
  const results = await Promise.all(all);
  say("results " + results.join(" "));
  const e = await store.run("outer", () => entering());
  say("entering returned " + e + " main sees " + current());
  await store.run("chain", async () => {
    const first = await worker(4, sleep(1));
    const second = await worker(5, sleep(2));
    say("chain " + first + " " + second);
  });
  say("main end " + current());
}

main().then(() => {
  for (const line of log) console.log(line);
});
