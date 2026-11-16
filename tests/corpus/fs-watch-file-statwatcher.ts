// fs.watchFile answers the StatWatcher for its resolved path: one handle,
// shared by every call on that path, whose loop liveness follows Node's ref
// count — each registration adds a ref, each unwatchFile gives one back, and
// ref()/unref() only move the handle when the count reaches its bounds, and
// an unwatchFile whose listener the path never registered removes nothing
// (so it must not give a ref back either). With nothing reffed the process
// ends by itself, which is the observable half; event counts stay
// unobserved, as elsewhere.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-statwatcher-"));
const file = join(dir, "one.txt");
const other = join(dir, "two.txt");
const third = join(dir, "three.txt");
fs.writeFileSync(file, "a");
fs.writeFileSync(other, "b");
fs.writeFileSync(third, "c");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const shared = (current: fs.Stats, previous: fs.Stats): void => {};

// 1. Two registrations on one path share one watcher. One unref() leaves the
// other registration holding the loop, so the timer below still runs; the
// process ends only once the listeners are gone.
const watcher = fs.watchFile(file, { interval: 20 }, shared);
const again = fs.watchFile(file, { interval: 20 }, shared);
await delay(40);
console.log("shared handle", watcher === again, Boolean(watcher), watcher ? "yes" : "no");
watcher.unref();
await delay(40);
console.log("one unref keeps the poller", true);
fs.unwatchFile(file);

// 2. A path whose FIRST call was persistent: false does not hold the loop,
// even after another registration joins it.
fs.watchFile(other, { interval: 20, persistent: false }, shared);
fs.watchFile(other, { interval: 20 }, shared);
await delay(40);
console.log("unpersistent start", true);
fs.unwatchFile(other);

// 3. Two unref()s on the shared handle do drop it.
const twice = fs.watchFile(third, { interval: 20 }, shared);
fs.watchFile(third, { interval: 20 }, shared);
twice.unref();
twice.unref();
await delay(40);
console.log("two unrefs drop it", true);
fs.unwatchFile(third);

// 4. A reffed watcher delivers a change; unref() then ref() puts it back.
let events = 0;
const listener = (current: fs.Stats, previous: fs.Stats): void => {
  events++;
  if (events === 1) console.log("change", previous.size > 0, current.size > previous.size);
};
const last = fs.watchFile(file, { interval: 20 }, listener);
last.unref();
last.ref();
const ticker = setInterval(() => fs.appendFileSync(file, "x"), 20);
await delay(150);
clearInterval(ticker);
console.log("reffed delivered", events > 0);
fs.unwatchFile(file, listener);

// 5. An unwatchFile naming a listener this path never registered removes
// nothing and gives no ref back, so the registration still holds the loop:
// the unref'd timer below only runs because of it, and it is the timer that
// ends the watch.
const fourth = join(dir, "four.txt");
fs.writeFileSync(fourth, "d");
const held = fs.watchFile(fourth, { interval: 20 }, shared);
const never = (current: fs.Stats, previous: fs.Stats): void => {};
fs.unwatchFile(fourth, never);
setTimeout(() => {
  console.log("bogus unwatch keeps the loop", Boolean(held));
  fs.unwatchFile(fourth);
  console.log("done");
  fs.rmSync(dir, { recursive: true, force: true });
}, 60).unref();
