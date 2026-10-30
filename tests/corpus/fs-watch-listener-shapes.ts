// fs.watch and fs.watchFile listeners of each shape. watcher.off of a
// 'change' listener that is not the last one leaves the others, in order.
// A one-parameter listener typed any and a two-parameter listener whose
// eventType is any receive the event name as a string. fs.watchFile
// listeners with no parameter and with one parameter run once per change
// a poll sees, like the two-parameter form. Event counts and coalescing are
// deliberately unobserved (they differ between inotify, kqueue and
// FSEvents); each watchFile change waits for the previous one's event.
// A path holding a null byte throws before anything is watched.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-shapes-"));
const file = join(dir, "data.txt");
fs.writeFileSync(file, "a");

try {
  fs.watch("bad\0path", () => {}).close();
  console.log("watch accepted");
} catch (err) {
  console.log("watch", (err as NodeJS.ErrnoException).code, (err as Error).message);
}

const order: string[] = [];
let anyEvent: any = null;
let dynEvent: any = null;
let named = 0;
const watcher = fs.watch(file, (eventType: any) => {
  if (anyEvent === null) anyEvent = eventType;
});
const first = () => {
  order.push("first");
};
const second = () => {
  order.push("second");
};
const third = () => {
  order.push("third");
};
watcher.on("change", first);
watcher.on("change", second);
watcher.on("change", third);
watcher.off("change", second);
watcher.on("change", (eventType: any, filename: any) => {
  if (dynEvent === null) dynEvent = eventType;
  if (filename !== null) named++;
});

const bound = setTimeout(() => {
  console.log("timed out");
  process.exit(1);
}, 10000);
const touch = setInterval(() => fs.appendFileSync(file, "x"), 40);
const poll = setInterval(() => {
  if (anyEvent === null || dynEvent === null || order.length < 2) return;
  clearInterval(poll);
  clearInterval(touch);
  watcher.close();
  console.log("after off", order.slice(0, 2).join(","));
  console.log("any eventType", typeof anyEvent, anyEvent === "change" || anyEvent === "rename");
  console.log("dynamic eventType", typeof dynEvent, dynEvent === "change" || dynEvent === "rename");
  startPolling();
}, 10);

function startPolling(): void {
  let zeroCalls = 0;
  let oneCalls = 0;
  let size = 0;
  const zero = (): void => {
    zeroCalls++;
  };
  const one = (current: fs.Stats): void => {
    oneCalls++;
    size = current.size;
    if (oneCalls < 3) {
      setTimeout(() => fs.writeFileSync(file, "x".repeat(oneCalls + 10)), 30);
      return;
    }
    setTimeout(() => {
      console.log("watchFile calls", zeroCalls === oneCalls, oneCalls, "size", size);
      fs.unwatchFile(file);
      clearTimeout(bound);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("done");
    }, 60);
  };
  fs.watchFile(file, { interval: 20 }, zero);
  fs.watchFile(file, { interval: 20 }, one);
  setTimeout(() => fs.writeFileSync(file, "x".repeat(10)), 100);
}
