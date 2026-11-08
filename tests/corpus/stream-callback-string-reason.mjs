// A stream's completion callback called with a string ends the stream with
// that string as its reason. `finished`, `pipeline`, their promise forms,
// `errored` and a `for await` over the stream all see the string itself, not
// an Error made from its text.
import { Duplex, Readable, Transform, Writable, finished, pipeline } from "node:stream";
import { finished as finishedSettled, pipeline as pipelineSettled } from "node:stream/promises";

function describe(value) {
  if (value instanceof Error) return `an Error (${value.message})`;
  if (value === null || value === undefined) return String(value);
  return `${typeof value} ${JSON.stringify(value)}`;
}

function report(label, value, expected) {
  console.log(`${label}: ${describe(value)}, the string itself: ${value === expected}`);
}

// write() of a Writable reports the string; finished() and errored see it.
function gangway() {
  return new Promise((resolve) => {
    const deck = new Writable({
      write(_car, _encoding, done) {
        done("gangway raised");
      },
    });
    finished(deck, (reason) => {
      report("gangway, finished", reason, "gangway raised");
      report("gangway, errored", deck.errored, "gangway raised");
      resolve(undefined);
    });
    deck.write("car 1");
  });
}

// final() of a Writable reports the string; pipeline()'s callback sees it.
function manifest() {
  return new Promise((resolve) => {
    const cars = new Readable({ read() {} });
    const deck = new Writable({
      write(_car, _encoding, done) {
        done();
      },
      final(done) {
        done("manifest incomplete");
      },
    });
    pipeline(cars, deck, (reason) => {
      report("manifest, pipeline", reason, "manifest incomplete");
      resolve(undefined);
    });
    cars.push("car 1");
    cars.push(null);
  });
}

// flush() of a Transform reports the string; the pipeline promise rejects
// with it.
async function weighbridge() {
  const cars = new Readable({ read() {} });
  const scale = new Transform({
    transform(car, _encoding, done) {
      done(null, car);
    },
    flush(done) {
      done("scale not zeroed");
    },
  });
  scale.resume();
  cars.push("car 1");
  cars.push(null);
  try {
    await pipelineSettled(cars, scale);
    console.log("weighbridge, pipeline promise: resolved");
  } catch (reason) {
    report("weighbridge, pipeline promise", reason, "scale not zeroed");
  }
}

// write() of a Duplex reports the string; the finished promise rejects with
// it.
async function ramp() {
  const lane = new Duplex({
    read() {},
    write(_car, _encoding, done) {
      done("ramp too steep");
    },
  });
  const settled = finishedSettled(lane);
  lane.write("car 1");
  try {
    await settled;
    console.log("ramp, finished promise: resolved");
  } catch (reason) {
    report("ramp, finished promise", reason, "ramp too steep");
  }
}

// transform() reports the string; a for await over the stream throws it.
async function ticketCheck() {
  const booth = new Transform({
    transform(_ticket, _encoding, done) {
      done("ticket for yesterday");
    },
  });
  booth.write("ticket 1");
  try {
    for await (const ticket of booth) console.log(`ticket check, passed: ${String(ticket)}`);
    console.log("ticket check, for await: ended");
  } catch (reason) {
    report("ticket check, for await", reason, "ticket for yesterday");
  }
}

// An empty string is no reason: the write succeeded.
function calmSea() {
  return new Promise((resolve) => {
    const deck = new Writable({
      write(_car, _encoding, done) {
        done("");
      },
    });
    finished(deck, (reason) => {
      console.log(`calm sea, finished: ${describe(reason)}, errored: ${describe(deck.errored)}`);
      resolve(undefined);
    });
    deck.end("car 1");
  });
}

// An Error given to the callback is still that Error.
function storm() {
  return new Promise((resolve) => {
    const warning = new RangeError("force 9");
    const deck = new Writable({
      write(_car, _encoding, done) {
        done(warning);
      },
    });
    finished(deck, (reason) => {
      console.log(`storm, finished: ${describe(reason)}, the same Error: ${reason === warning}`);
      resolve(undefined);
    });
    deck.write("car 1");
  });
}

await gangway();
await manifest();
await weighbridge();
await ramp();
await ticketCheck();
await calmSea();
await storm();
console.log("done");
