// Writable.toWeb over a value that is not a native stream: Node accepts any
// object with write() and on() and drives it through the adapter.
import { Writable } from "node:stream";

const encoder = new TextEncoder();
const log = [];

function fakeWritable(highWaterMark = 16) {
  const listeners = new Map();
  const emit = (name, arg) => {
    for (const fn of listeners.get(name) ?? []) fn(arg);
  };
  const target = {
    writable: true,
    destroyed: false,
    writableHighWaterMark: highWaterMark,
    chunks: [],
    destroys: [],
    write(chunk) {
      target.chunks.push(Buffer.from(chunk).toString());
      return true;
    },
    emitLocal(name, arg) {
      emit(name, arg);
    },
    end() {
      target.writable = false;
      setImmediate(() => {
        emit("finish");
        emit("close");
      });
    },
    destroy(error) {
      target.destroyed = true;
      target.writable = false;
      target.destroys.push(error === undefined ? "undefined" : `${error.name}:${error.code}`);
      if (error) emit("error", error);
      setImmediate(() => emit("close"));
    },
    on(name, fn) {
      const list = listeners.get(name);
      if (list) list.push(fn);
      else listeners.set(name, [fn]);
      return target;
    },
    removeListener(name, fn) {
      const list = listeners.get(name);
      if (list) listeners.set(name, list.filter((entry) => entry !== fn));
      return target;
    },
  };
  return target;
}

const fake = fakeWritable(2);
const writer = Writable.toWeb(fake).getWriter();
log.push(`desired ${writer.desiredSize}`);
await writer.write(encoder.encode("ab"));
log.push(`chunks ${fake.chunks.join("|")} desired ${writer.desiredSize}`);
await writer.close();
log.push(`ended ${fake.writable}`);

const aborted = fakeWritable();
const abortedWriter = Writable.toWeb(aborted).getWriter();
await abortedWriter.abort(new Error("stop"));
await new Promise((resolve) => setTimeout(resolve, 10));
log.push(`aborted ${aborted.destroyed}`);

// A cancellation without a reason destroys with Node's AbortError, not a
// clean destroy.
const bare = fakeWritable();
const bareWriter = Writable.toWeb(bare).getWriter();
await bareWriter.abort();
await new Promise((resolve) => setTimeout(resolve, 10));
log.push(`bare abort destroy ${bare.destroys.join("|")}`);

// A writable that closes without finishing leaves the writer's pending close
// rejecting with the AbortError Node's eos calls a premature close.
const premature = fakeWritable();
premature.end = function () {
  setImmediate(() => this.emitLocal("close"));
};
const prematureWriter = Writable.toWeb(premature).getWriter();
const prematureClose = prematureWriter.close().then(
  () => "resolved",
  (error) => `rejected ${error.name} ${error.code}`,
);
log.push(`premature close ${await prematureClose}`);

// A value without write() and on() throws Node's ERR_INVALID_ARG_TYPE.
for (const value of [42, {}]) {
  try {
    Writable.toWeb(value);
    log.push("invalid accepted");
  } catch (error) {
    log.push(`${error.name} ${error.code}`);
  }
}

// A value that reports itself not writable adapts to a closed stream.
const closed = fakeWritable();
closed.writable = false;
const closedWriter = Writable.toWeb(closed).getWriter();
await closedWriter.write(encoder.encode("x")).then(
  () => log.push("closed write resolved"),
  (error) => log.push(`closed write rejected ${error.code}`),
);

for (const line of log) console.log(line);
