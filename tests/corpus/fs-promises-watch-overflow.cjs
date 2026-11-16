// @normalize-pid
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
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
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

// A burst that fills the queue while the loop body awaits other work: the
// overflow error must surface on the next wait even though no event arrives
// afterwards to wake it. The writer fires once, inside the body's delay.
async function burstWhileBusy() {
  // The entry the body takes, then a finite burst lands inside the body's
  // delay: one entry fills the single slot, the next overflows it.
  setTimeout(() => fs.appendFileSync(file, "b0"), 5);
  try {
    for await (const info of fsp.watch(file, { maxQueue: 1, overflow: "error" })) {
      let written = 0;
      const burst = setInterval(() => {
        fs.appendFileSync(file, "b");
        if (++written === 6) clearInterval(burst);
      }, 3);
      await delay(40);
    }
    console.log("burst", "no error");
  } catch (err) {
    console.log("burst", err.code, err.message);
  }
}

// A zero bound with overflow: "ignore" drops every event, and a dropped
// event must not wake the loop as though it had queued one: nothing is
// reffed here (persistent: false), so a parked iteration ends the process
// where a spurious wake would take an empty queue as an entry.
function droppedEvent() {
  setTimeout(() => fs.appendFileSync(file, "d"), 10);
  setTimeout(() => console.log("dropped stayed parked", true), 40);
  dropped();
}

async function dropped() {
  for await (const info of fsp.watch(file, { maxQueue: 0, persistent: false, overflow: "ignore" })) {
    console.log("dropped woke", info.eventType);
  }
}

(async () => {
  await overflowError();
  await badMaxQueue(1.5);
  await burstWhileBusy();
  // The overflow error ends that iteration; a later watch on the same path
  // still iterates (the queue is per iterator).
  const ticker = setInterval(() => fs.appendFileSync(file, "z"), 10);
  for await (const info of fsp.watch(file, { maxQueue: 4, overflow: "ignore" })) {
    console.log("recovered", info.filename === "a.txt");
    break;
  }
  clearInterval(ticker);
  droppedEvent();
})();
