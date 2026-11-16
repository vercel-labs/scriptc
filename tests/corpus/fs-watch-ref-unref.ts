// FSWatcher.ref/unref and fs.watch's persistent option. A watcher created
// with persistent: false does not hold the loop by itself; ref() puts it
// back on the loop and close() takes it off again (twice is a no-op). An
// unref'd watcher still delivers events while something else holds the
// loop, and the program ends with it still open — nothing reffed is left.
// Event counts and coalescing stay unobserved, as elsewhere; only "did one
// arrive" is printed.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-ref-"));
const file = join(dir, "data.txt");
fs.writeFileSync(file, "a");

// ref(): nothing else holds the loop here, so the event below arrives only
// while the reffed watcher keeps the process running.
const reffed = fs.watch(file, { persistent: false }, () => {
  reffed.close();
  reffed.close();
  console.log("reffed watcher delivered");
});
reffed.ref();
fs.appendFileSync(file, "x");

// Two watchers on one path share the kernel's watch: closing one leaves
// the other delivering.
let peerClosed = 0;
let peerOpen = 0;
const first = fs.watch(file, () => {
  peerClosed++;
});
const second = fs.watch(file, () => {
  peerOpen++;
});
first.close();
await new Promise<void>((resolve) => {
  fs.appendFileSync(file, "z");
  setTimeout(resolve, 100);
});
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
