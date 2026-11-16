// fs.watchFile answers the StatWatcher its listener registered on:
// ref()/unref() move that registration's loop liveness (the `persistent`
// option is its initial state, per call even on a path another call already
// polls), and the watcher answers no close() — fs.unwatchFile is the removal
// API. With nothing reffed the process ends by itself, which is the
// observable half; event counts stay unobserved, as elsewhere.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-statwatcher-"));
const file = join(dir, "one.txt");
const other = join(dir, "two.txt");
fs.writeFileSync(file, "a");
fs.writeFileSync(other, "b");

let events = 0;
const listener = (current: fs.Stats, previous: fs.Stats): void => {
  events++;
  if (events === 1) console.log("change", previous.size > 0, current.size > previous.size);
};

// The reffed watcher: unref() then ref() puts it back on the loop, and a
// doubled ref() is a no-op.
const watcher = fs.watchFile(file, { interval: 20 }, listener);
watcher.unref();
watcher.ref();
watcher.ref();

// A second registration on a DIFFERENT path, started unref'd: it does not
// hold the loop and is never unwatched.
const quiet = fs.watchFile(other, { interval: 20, persistent: false }, () => {});
quiet.unref();

const ticker = setInterval(() => fs.appendFileSync(file, "x"), 20);
setTimeout(() => {
  clearInterval(ticker);
  console.log("reffed delivered", events > 0);
  fs.unwatchFile(file, listener);
  watcher.unref();
  watcher.ref();
  console.log("done");
  fs.rmSync(dir, { recursive: true, force: true });
}, 150);
