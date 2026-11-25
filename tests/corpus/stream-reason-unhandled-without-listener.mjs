// A stream that ends with a reason that is not an Error and has no 'error'
// listener leaves the value unhandled the way an emitter's emit does: the
// process hears ERR_UNHANDLED_ERROR, whose context is the value. An Error is
// unhandled as itself.
import { Duplex, Transform, Writable } from "node:stream";

function describe(value) {
  if (value instanceof Error) {
    const code = typeof value.code === "string" ? `, code ${value.code}` : "";
    const context = "context" in value ? `, context ${describe(value.context)}` : "";
    return `${value.name} (${value.message}${code}${context})`;
  }
  return `${typeof value} ${JSON.stringify(value)}`;
}

let current = "";
process.on("uncaughtException", (failure) => {
  console.log(`${current}: the process heard ${describe(failure)}`);
});

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 5, undefined));
}

// The write callback of a Writable called with the reason.
async function refused(label, reason) {
  current = label;
  const hold = new Writable({
    write(_crate, _encoding, done) {
      done(reason);
    },
  });
  hold.write("crate 1");
  await settle();
  console.log(`${label}: destroyed ${hold.destroyed}, errored ${describe(hold.errored)}`);
}

// The final callback of a Writable.
async function unsealed(label, reason) {
  current = label;
  const hold = new Writable({
    write(_crate, _encoding, done) {
      done();
    },
    final(done) {
      done(reason);
    },
  });
  hold.end("crate 1");
  await settle();
  console.log(`${label}: destroyed ${hold.destroyed}, errored ${describe(hold.errored)}`);
}

// The transform callback of a Transform.
async function misweighed(label, reason) {
  current = label;
  const scale = new Transform({
    transform(_crate, _encoding, done) {
      done(reason);
    },
  });
  scale.write("crate 1");
  await settle();
  console.log(`${label}: destroyed ${scale.destroyed}, errored ${describe(scale.errored)}`);
}

// The write callback of a Duplex.
async function jammed(label, reason) {
  current = label;
  const crane = new Duplex({
    read() {},
    write(_crate, _encoding, done) {
      done(reason);
    },
  });
  crane.write("crate 1");
  await settle();
  console.log(`${label}: destroyed ${crane.destroyed}, errored ${describe(crane.errored)}`);
}

await refused("write callback, number", 19);
await refused("write callback, string", "hatch ajar");
await refused("write callback, true", true);
await refused("write callback, an Error", new RangeError("overweight"));
await unsealed("final callback, number", 19);
await unsealed("final callback, string", "hatch ajar");
await misweighed("transform callback, number", 19);
await misweighed("transform callback, string", "hatch ajar");
await jammed("duplex write callback, true", true);
console.log("done");
