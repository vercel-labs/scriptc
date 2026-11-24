// After every callback (immediates, timers, I/O callbacks) Node drains the
// process.nextTick queue, nested ticks included, before promise jobs and
// queueMicrotask callbacks, then repeats until both are empty.
import { readFile } from "node:fs";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

const log: string[] = [];
function mark(phase: string): void {
  queueMicrotask(() => log.push(`${phase}:microtask`));
  void Promise.resolve().then(() => log.push(`${phase}:then`));
  process.nextTick(() => {
    log.push(`${phase}:tick`);
    process.nextTick(() => log.push(`${phase}:nested tick`));
    queueMicrotask(() => log.push(`${phase}:tick microtask`));
  });
  log.push(phase);
}

function done(label: string): void {
  console.log(label, log.join(" "));
  log.length = 0;
}

// Each section starts from the previous one's last callback, so machine
// speed cannot move a callback into another section's line.
setImmediate(() => mark("immediate 1"));
setImmediate(() => mark("immediate 2"));
setImmediate(() =>
  setImmediate(() => {
    done("immediates");
    timers();
  }),
);

function timers(): void {
  setTimeout(() => mark("timer 1"), 1);
  setTimeout(() => mark("timer 2"), 1);
  setTimeout(() => {
    done("timers");
    io();
  }, 30);
}

function io(): void {
  readFile(self, "utf8", () => {
    mark("readFile 1");
    readFile(self, "utf8", () => {
      mark("readFile 2");
      setImmediate(() => mark("immediate after io"));
      setTimeout(() => {
        mark("timeout after io");
        setImmediate(() => {
          done("io");
          setTimeout(tickOnly, 0);
        });
      }, 0);
      // Stay in the I/O callback past the timer's deadline: Node's check
      // phase (this setImmediate) runs before the next timers phase even
      // when the timer is already due, so the order must not depend on how
      // quickly the loop gets back here.
      const until = Date.now() + 3;
      while (Date.now() < until) {}
    });
  });
}

function tickOnly(): void {
  setTimeout(() => {
    log.push("tick-only timer 1");
    process.nextTick(() => log.push("timer 1 tick"));
  }, 1);
  setTimeout(() => log.push("tick-only timer 2"), 1);
  setImmediate(() => {
    log.push("tick-only immediate 1");
    process.nextTick(() => log.push("immediate 1 tick"));
  });
  setImmediate(() => log.push("tick-only immediate 2"));
  setTimeout(() => done("tick only"), 40);
}
