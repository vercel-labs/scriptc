// fs.watch on a directory, non-recursive: a write to a file already in it
// (rewritten in place, then appended to) is delivered, and a write to a
// file one directory down is not, on every target. A directory's own inode
// does not change when a file inside it is written, so a watch on that
// inode alone would see neither write. The listener ignores the entry name,
// and each phase reports only that an event arrived: FSEvents coalesces a
// file's recent creation into a later modify, so the event's name can
// differ between runs. Triggers RETRY on an interval until the event lands,
// because Node-on-macOS's FSEvents stream starts asynchronously, and a
// bound turns a dead watcher into a loud nonzero exit instead of a hang.
// The nested check runs only after the first delivery, once the stream is
// known to be live, so a lost startup window cannot pass it.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-watch-dir-"));
const file = join(dir, "file.txt");
const nested = join(dir, "sub", "nested.txt");
fs.writeFileSync(file, "seed");
fs.mkdirSync(join(dir, "sub"));
fs.writeFileSync(nested, "seed");

let events = 0;
const watcher = fs.watch(dir, () => {
  events += 1;
});

/** Runs `trigger` every 50 ms until an event arrives, then `next`. */
function until(label: string, trigger: () => void, next: () => void): void {
  const before = events;
  let kicks = 0;
  const kick = setInterval(() => {
    if (events > before) {
      clearInterval(kick);
      console.log(label + " delivered");
      next();
      return;
    }
    kicks += 1;
    if (kicks > 600) {
      console.error(label + " never delivered");
      process.exit(1);
    }
    trigger();
  }, 50);
}

let round = 0;
until("in-place rewrite", () => fs.writeFileSync(file, "rewrite " + String(++round)), () => {
  // The stream is live: let any trailing delivery of the rewrite settle,
  // then write one directory down and watch for nothing.
  setTimeout(() => {
    const before = events;
    fs.writeFileSync(nested, "deeper");
    setTimeout(() => {
      console.log("nested write delivered: " + String(events > before));
      until("append", () => fs.appendFileSync(file, "+"), () => {
        watcher.close();
        fs.rmSync(dir, { recursive: true, force: true });
        console.log("closed");
      });
    }, 500);
  }, 300);
});
