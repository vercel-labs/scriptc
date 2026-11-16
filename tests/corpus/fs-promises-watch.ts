// fsPromises.watch yields Node's async iteration over fs.watch: each entry
// is the { eventType, filename } record the platform reported, the watch is
// closed when the loop ends (break, throw or return), and a
// persistent: false watch never holds the process open. Event counts and
// kinds vary by platform, so the program observes the record's shape, the
// name the platform reported, and that the process ends by itself once the
// loop is done.
import * as fs from "node:fs";
import { watch } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-fsp-watch-"));
const file = join(dir, "a.txt");
fs.writeFileSync(file, "x");

// 1. One entry arrives with the queued record's shape; breaking out of the
// loop closes the watch (nothing reffed is left, so the process would hang
// if it stayed open).
const ticker = setInterval(() => fs.appendFileSync(file, "y"), 20);
let entries = 0;
for await (const info of watch(file, { encoding: "utf8" })) {
  entries++;
  console.log(
    "entry",
    typeof info.eventType,
    typeof info.filename,
    info.filename === "a.txt",
    info.eventType === "change" || info.eventType === "rename",
  );
  if (entries === 1) break;
}
clearInterval(ticker);
console.log("entries", entries > 0);

// 2. The iterator answers a whole directory watch too: a new entry there is
// named by the platform. macOS is skipped on both sides: the watch unit
// refuses a directory watcher that reads the entry name there (kqueue names
// no entries), which is the fence fs.watch's two-argument listener has.
let named = false;
if (process.platform !== "darwin") {
  const dirTicker = setInterval(
    () => fs.writeFileSync(join(dir, `n${Date.now()}.txt`), "z"),
    20,
  );
  for await (const info of fs.promises.watch(dir)) {
    if (typeof info.filename === "string" && info.filename.length > 0) named = true;
    break;
  }
  clearInterval(dirTicker);
}
console.log("directory entry named", named);

// 3. persistent: false still iterates while something else holds the loop,
// and breaking out closes the watch like the default does.
const looseTicker = setInterval(() => fs.appendFileSync(file, "z"), 20);
let loose = 0;
for await (const info of watch(file, { persistent: false })) {
  loose++;
  console.log("unpersistent entry", info.filename === "a.txt");
  break;
}
clearInterval(looseTicker);
console.log("unpersistent iterates", loose === 1);

fs.rmSync(dir, { recursive: true, force: true });
