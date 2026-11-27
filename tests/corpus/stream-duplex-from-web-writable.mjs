// Duplex.from over a lone web WritableStream, and a compose that ends with
// one: Node reads the stream as the body's writable side, so the Duplex is
// writable only, writes reach the web sink's write(), finish waits for the
// writer to close, and destroying it aborts the web stream with the reason.
import { Duplex, PassThrough, compose } from "node:stream";

const log = [];

function sinkInto(into, tag) {
  return new WritableStream({
    write(chunk) {
      into.push(`${tag} ${typeof chunk} ${String(chunk)}`);
    },
  });
}

{
  const got = [];
  const duplex = Duplex.from(sinkInto(got, "from"));
  log.push(`from modes r=${duplex.readable} w=${duplex.writable}`);
  const done = new Promise((resolve, reject) =>
    duplex.on("finish", resolve).on("error", reject),
  );
  duplex.write("a");
  duplex.write(Buffer.from("b"));
  duplex.end();
  await done;
  log.push(`from got ${got.join(" | ")}`);
  log.push(`from state finished=${duplex.writableFinished} destroyed=${duplex.destroyed}`);
}

{
  const got = [];
  const composed = compose(new PassThrough(), sinkInto(got, "comp"));
  const done = new Promise((resolve, reject) =>
    composed.on("finish", resolve).on("error", reject),
  );
  composed.write("c");
  composed.end();
  await done;
  log.push(`compose got ${got.join(" | ")}`);
}

{
  // the chunks the stage before it writes arrive as they are
  const got = [];
  const composed = compose(new PassThrough({ objectMode: true }), sinkInto(got, "object-mode"));
  const done = new Promise((resolve, reject) =>
    composed.on("finish", resolve).on("error", reject),
  );
  composed.write("s");
  composed.end();
  await done;
  log.push(`object-mode head ${got.join(" | ")}`);
}

{
  const events = [];
  const duplex = Duplex.from(
    new WritableStream({
      write() {},
      abort(reason) {
        events.push(`abort ${String(reason)}`);
      },
    }),
  );
  duplex.on("error", (error) => events.push(`error ${error.message}`));
  duplex.destroy(new Error("killed"));
  await new Promise((resolve) => duplex.on("close", resolve));
  log.push(`destroy events ${events.join(" | ")} destroyed=${duplex.destroyed}`);
}

{
  // a null a web stage enqueues reaches a lone web WritableStream's write
  const got = [];
  const nuller = new TransformStream({
    transform(_chunk, controller) {
      controller.enqueue(null);
    },
  });
  const sink = new WritableStream({
    write(chunk) {
      got.push(chunk === null ? "null" : String(chunk));
    },
  });
  const composed = compose(new PassThrough(), nuller, sink);
  const done = new Promise((resolve, reject) => composed.on("finish", resolve).on("error", reject));
  composed.write("x");
  composed.end();
  await done;
  console.log("null stage", got.join(","));
}

console.log(log.join("\n"));
