// fs.watch listeners that take the filename, on a FILE watch: the
// filename is the watched file's basename. The listener can be a runtime
// value typed WatchListener<string>, and the watcher's EventEmitter
// surface takes more 'change' listeners (on), a one-shot one (once), an
// 'error' listener (never called here), and a 'close' listener, which
// runs on the next tick after close() (before immediates) and only once
// however often close() is called. Triggers repeat on an interval until
// the event lands; event counts and coalescing are deliberately
// unobserved (they differ between inotify, kqueue and FSEvents).
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-names-"));
const head = join(dir, "HEAD");
fs.writeFileSync(head, "ref: main\n");

let firstName: string | null = "unset";
let secondName = "unset";
let onceCalls = 0;
const listener: fs.WatchListener<string> = (eventType, filename) => {
  if (firstName !== "unset") return;
  firstName = filename;
  console.log("listener value names", filename, eventType === "change" || eventType === "rename");
};
const watcher = fs.watch(head, listener);
// 'change' listener named as any: the @types/node overload declares
// filename string | Buffer, whose bytes arm has no lowering (Node passes a
// string with the default encoding), so the checked name arrives as dyn.
watcher.on("change", (_eventType: string, filename: any) => {
  if (secondName !== "unset") return;
  secondName = String(filename);
  console.log("on('change') names", secondName);
});
watcher.once("change", () => {
  onceCalls++;
});
watcher.on("error", (error: Error) => console.log("error", error.message));
watcher.on("close", () => {
  console.log("close event", onceCalls);
  setImmediate(() => {
    console.log("immediate after close");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const bound = setTimeout(() => {
  console.log("timed out");
  process.exit(1);
}, 10000);
const touch = setInterval(() => fs.appendFileSync(head, "x"), 40);
const poll = setInterval(() => {
  if (firstName === "unset" || secondName === "unset") return;
  clearInterval(poll);
  clearInterval(touch);
  clearTimeout(bound);
  watcher.close();
  watcher.close();
  console.log("closed");
}, 10);
