// WritableStream and its default writer in a JavaScript source: the sink
// callbacks, the writer's desiredSize, ready and closed promises, locked
// and releaseLock, the unbound write, constructing a writer over a stream
// and over a locked one, the illegal controller constructor, a size
// strategy, the abort reason a later write rejects with, and the errors
// sink failures carry.
const describe = (error) => error.name + " " + String(error.code) + " " + error.message;
const events = [];

const sink = new WritableStream({
  start() { events.push("start"); },
  write(chunk) { events.push("write " + chunk); },
  close() { events.push("close"); },
  abort(reason) { events.push("abort " + reason); },
});
console.log("locked", sink.locked);
const writer = sink.getWriter();
console.log("writer locked", sink.locked, "desired", writer.desiredSize);
console.log("writer class", writer instanceof WritableStreamDefaultWriter, Object.prototype.toString.call(sink));
await writer.write(1);
await writer.write(2);
await writer.close();
console.log("events", events.join("|"), "locked", sink.locked);
writer.releaseLock();
console.log("released", sink.locked);
try {
  await writer.write(3);
} catch (e) {
  console.log("unbound", describe(e));
}

const target = new WritableStream({ write(chunk) { console.log("target", chunk); } });
const first = target.getWriter();
try {
  new WritableStreamDefaultWriter(target);
} catch (e) {
  console.log("locked writer", describe(e));
}
first.releaseLock();
const second = new WritableStreamDefaultWriter(target);
console.log("default writer", second.desiredSize, target.locked);
await second.write(4);
await second.close();
try {
  new WritableStreamDefaultWriter();
} catch (e) {
  console.log("no stream", describe(e));
}

try {
  new WritableStreamDefaultController();
} catch (e) {
  console.log("controller", describe(e));
}

const sized = new WritableStream({ write() {} }, { highWaterMark: 2, size(chunk) { return chunk.length; } });
const sizedWriter = sized.getWriter();
console.log("sized", sizedWriter.desiredSize);
await sizedWriter.write("abc");
console.log("sized", sizedWriter.desiredSize);

try { new WritableStream({ write: 5 }); } catch (e) { console.log("write not fn", describe(e)); }
try { new WritableStream({ close: 5 }); } catch (e) { console.log("close not fn", describe(e)); }
try { new WritableStream("nope"); } catch (e) { console.log("sink str", describe(e)); }

const boom = new Error("boom");
const failing = new WritableStream({ write() { throw boom; } });
const failingWriter = failing.getWriter();
const closed = failingWriter.closed.catch((e) => console.log("closed same", e === boom));
try {
  await failingWriter.write(1);
} catch (e) {
  console.log("write same", e === boom);
}
await closed;
try {
  await failingWriter.write(2);
} catch (e) {
  console.log("after error same", e === boom);
}

const closeFails = new WritableStream({ write() {}, close() { throw new Error("closefail"); } });
const closeWriter = closeFails.getWriter();
try {
  await closeWriter.close();
} catch (e) {
  console.log("close rejected", e.message);
}
try {
  await closeWriter.closed;
} catch (e) {
  console.log("closed rejected", e.message);
}

const abortReason = new Error("gone");
const aborted = new WritableStream({ abort(reason) { console.log("sink abort", String(reason)); } });
const abortingWriter = aborted.getWriter();
await abortingWriter.abort(abortReason);
console.log("aborted locked", aborted.locked);
try {
  await abortingWriter.write(1);
} catch (e) {
  console.log("write after abort same", e === abortReason);
}

const stringAborted = new WritableStream({ abort() {} });
const stringWriter = stringAborted.getWriter();
await stringWriter.abort("because");
try {
  await stringWriter.write(1);
} catch (e) {
  console.log("string reason", typeof e, String(e));
}
