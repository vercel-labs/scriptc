// FSWatcher.ref/unref and fs.watch's persistent option. A watcher created
// with persistent: false does not hold the loop by itself; ref() puts it
// back on the loop and close() takes it off again (twice is a no-op). An
// unref'd watcher still delivers events while something else holds the
// loop, and the program ends with it still open — nothing reffed is left.
// Event counts and coalescing stay unobserved, as elsewhere; only "did one
// arrive" is printed. The callbacks are waited for rather than raced against
// a fixed timer: Node's FSEvents watcher on macOS delivers tens of
// milliseconds after a native one, and a fixed wait printed the sections in
// whichever order the platform's delivery latency chose.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-ref-"));
const file = join(dir, "data.txt");
fs.writeFileSync(file, "a");

// A watcher callback's first delivery: the promise settles on the event, or
// after a generous timeout so a broken watch fails the corpus instead of
// hanging it.
function firstEvent(
  label: string,
  abandon?: () => void,
): { ready: Promise<void>; arrived: () => void } {
  let arrived: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.log(`${label} timed out`);
      abandon?.();
      resolve();
    }, 5000);
    arrived = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { ready, arrived };
}

// ref(): nothing else holds the loop here, so the event below arrives only
// while the reffed watcher keeps the process running.
let reffed: fs.FSWatcher;
const reffedFirst = firstEvent("reffed watcher", () => reffed.close());
reffed = fs.watch(file, { persistent: false }, () => {
  reffed.close();
  reffed.close();
  console.log("reffed watcher delivered");
  reffedFirst.arrived();
});
reffed.ref();
fs.appendFileSync(file, "x");
await reffedFirst.ready;

// Two watchers on one path share the kernel's watch: closing one leaves
// the other delivering. The second's event is awaited; the closed one gets
// the same kernel event, so it has had its chance by then.
let peerClosed = 0;
let peerOpen = 0;
const peerFirst = firstEvent("peer watcher");
const first = fs.watch(file, () => {
  peerClosed++;
});
const second = fs.watch(file, () => {
  peerOpen++;
  peerFirst.arrived();
});
first.close();
fs.appendFileSync(file, "z");
await peerFirst.ready;
await new Promise<void>((resolve) => setTimeout(resolve, 50));
console.log("peer after close", peerClosed === 0, peerOpen > 0);
second.close();

// persistent: false + unref(): events still arrive while the ticker holds
// the loop.
await new Promise<void>((resolve) => {
  let delivered = 0;
  const unrefd = fs.watch(file, { persistent: false }, () => {
    delivered++;
  });
  unrefd.unref();
  const ticker = setInterval(() => fs.appendFileSync(file, "y"), 20);
  setTimeout(() => {
    clearInterval(ticker);
    unrefd.unref();
    console.log("unref'd watcher delivered", delivered > 0);
    resolve();
  }, 150);
});

fs.rmSync(dir, { recursive: true, force: true });
