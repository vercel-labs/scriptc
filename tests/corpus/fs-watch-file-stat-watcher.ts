// fs.watchFile answers the path's StatWatcher: one record per resolved path,
// shared by every call on it (relative spellings resolve to the same one),
// while another path answers another record. ref() and unref() answer the
// record itself so they chain, and both stay callable (as no-ops) once the
// poller stopped. unwatchFile moves the counters: a removal that finds no
// listener changes nothing, one that removes a listener lowers the maximum,
// and removing every listener stops the poller — a later watchFile on the
// path then answers a NEW record.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-statwatcher-"));
const shared = path.join(dir, "shared.txt");
const other = path.join(dir, "other.txt");
fs.writeFileSync(shared, "one");
fs.writeFileSync(other, "two");

const firstEvents: string[] = [];
const secondEvents: string[] = [];
const first = fs.watchFile(shared, { interval: 20 }, (current, previous) => {
  if (firstEvents.length === 0) firstEvents.push(`${previous.size}->${current.size}`);
});
const second = fs.watchFile(shared, { interval: 20 }, (current, previous) => {
  if (secondEvents.length === 0) secondEvents.push(`${previous.size}->${current.size}`);
});

console.log("one record per path", first === second);
console.log("relative spelling", first === fs.watchFile(path.join(dir, ".", "shared.txt"), { interval: 20 }, () => {}));
console.log("another path", first === fs.watchFile(other, { interval: 20 }, () => {}));
console.log("ref answers it", first.ref() === first);
console.log("unref answers it", first.unref() === first);
console.log("chains", first.ref().unref().ref() === first);
console.log("options ignored on a watched path", first === fs.watchFile(shared, { interval: -1 }, () => {}));

setTimeout(() => fs.appendFileSync(shared, "22"), 60);

setTimeout(() => {
  console.log("events", firstEvents.join(","), secondEvents.join(","));
  // A listener that is not registered changes no counter.
  fs.unwatchFile(shared, () => {});
  console.log("unaffected", first.ref() === first);
  // 'clean': the maximum drops with the live count, the handle keeps ref'd
  // while the count is above zero.
  fs.unwatchFile(other);
  fs.unwatchFile(shared, () => {});
  console.log("still one record", first === fs.watchFile(shared, { interval: 20 }, () => {}));
  fs.unwatchFile(shared);
  console.log("stopped record answers", first.ref() === first, first.unref() === first);
  const restarted = fs.watchFile(shared, { interval: 20 }, () => {});
  console.log("new record after stop", restarted === first);
  fs.unwatchFile(shared);
  fs.unwatchFile(other);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("done");
}, 160);
