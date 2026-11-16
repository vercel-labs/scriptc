// fsPromises.watch bounds its queue the way Node does. options.maxQueue caps
// the pending entries (2048 by default), so a writer that outruns the
// consumer cannot grow the iterator's memory without limit; past the cap
// overflow: "error" clears the queue and fails the iteration with
// ERR_FS_WATCH_QUEUE_OVERFLOW, where overflow: "ignore" (the default) drops
// the event. A maxQueue that is not an integer is Node's
// ERR_OUT_OF_RANGE before the watch opens. The options are runtime-only
// (Node's typings do not declare them), so the program is CommonJS.
const fs = require("node:fs");
const fsp = require("node:fs/promises");

const dir = fs.mkdtempSync("/tmp/scr-fsp-watch-queue-");
const file = dir + "/a.txt";
fs.writeFileSync(file, "x");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function overflowError() {
  // Four appends every 2 ms against a consumer that sleeps 30 ms: the single
  // pending slot overflows before the loop takes its next entry.
  const flood = setInterval(() => {
    for (let i = 0; i < 4; i++) fs.appendFileSync(file, "q");
  }, 2);
  try {
    for await (const info of fsp.watch(file, { maxQueue: 1, overflow: "error" })) {
      await delay(30);
    }
    console.log("overflow", "no error", false);
  } catch (err) {
    console.log("overflow", err.name, err.code, err.message);
  }
  clearInterval(flood);
}

async function badMaxQueue(value) {
  try {
    for await (const info of fsp.watch(file, { maxQueue: value })) {
      break;
    }
    console.log("maxQueue", String(value), "accepted");
  } catch (err) {
    console.log("maxQueue", String(value), err.name, err.code, err.message);
  }
}

(async () => {
  await overflowError();
  await badMaxQueue(1.5);
  // The overflow error ends that iteration; a later watch on the same path
  // still iterates (the queue is per iterator).
  const ticker = setInterval(() => fs.appendFileSync(file, "z"), 10);
  for await (const info of fsp.watch(file, { maxQueue: 4, overflow: "ignore" })) {
    console.log("recovered", info.filename === "a.txt");
    break;
  }
  clearInterval(ticker);
  fs.rmSync(dir, { recursive: true, force: true });
})();
