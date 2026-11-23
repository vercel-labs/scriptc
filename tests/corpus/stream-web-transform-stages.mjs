// A web TransformStream as a stream.compose or pipeline stage: Node accepts
// it as the readable/writable pair it carries, so the previous stage pipes
// into its writable side and the next reads its readable side. Errors and an
// aborted pipeline signal travel the pipeline's usual paths, and a stage that
// is not a stream at all still gets Node's ERR_INVALID_ARG_TYPE.
import { PassThrough, Readable, Writable, compose } from "node:stream";
import { pipeline } from "node:stream/promises";

const upper = () =>
  new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(String(chunk).toUpperCase());
    },
  });

function collect() {
  const out = [];
  const writable = new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      out.push(String(chunk));
      cb();
    },
  });
  return { out, writable };
}

/** The chunk's type with its value: a web stage's chunks reach the next
 * stage untouched, numbers and objects included. */
function collectTyped() {
  const out = [];
  const writable = new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      out.push(`${typeof chunk}:${JSON.stringify(chunk)}`);
      cb();
    },
  });
  return { out, writable };
}

{
  const { out, writable } = collect();
  await pipeline(Readable.from(["ab"]), upper(), writable);
  console.log("pipeline", out.join(","));
}

{
  const { out, writable } = collect();
  const composed = compose(new PassThrough(), upper(), writable);
  const done = new Promise((resolve, reject) => composed.on("finish", resolve).on("error", reject));
  composed.write("cd");
  composed.end();
  await done;
  console.log("compose", out.join(","));
}

// A plain { readable, writable } pair of web streams is a stage too, and
// the pipeline pumps its web sides with the chunks untouched: numbers and
// objects reach the transform and the next stage as the values they are.
{
  const { out, writable } = collectTyped();
  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(String(chunk).toUpperCase());
    },
  });
  await pipeline(Readable.from(["ab"]), { readable: transform.readable, writable: transform.writable }, writable);
  console.log("pair pipeline", out.join(","));
}

{
  const { out, writable } = collectTyped();
  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk * 2);
    },
  });
  await pipeline(Readable.from([1, 2, 3]), { readable: transform.readable, writable: transform.writable }, writable);
  console.log("pair numbers", out.join(","));
}

{
  const { out, writable } = collectTyped();
  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue({ v: chunk.a + 1 });
    },
  });
  await pipeline(Readable.from([{ a: 1 }]), transform, writable);
  console.log("transform objects", out.join(","));
}

{
  const { out, writable } = collectTyped();
  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue({ v: chunk.a + 1 });
    },
  });
  await pipeline(Readable.from([{ a: 1 }]), { readable: transform.readable, writable: transform.writable }, writable);
  console.log("pair objects", out.join(","));
}

{
  const { out, writable } = collectTyped();
  const transform = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
  const composed = compose(
    new PassThrough(),
    { readable: transform.readable, writable: transform.writable },
    writable,
  );
  const done = new Promise((resolve, reject) => composed.on("finish", resolve).on("error", reject));
  composed.write("cd");
  composed.end();
  await done;
  console.log("compose pair", out.join(","));
}

// A null chunk from a web stage is a web value: the next web stage sees it
// (and so does every chunk after it in the same stage), where a node
// readable's push(null) would end the adapted stream.
{
  const { out, writable } = collect();
  const nuller = new TransformStream({
    transform(_chunk, controller) {
      controller.enqueue(null);
    },
  });
  const watcher = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk === null ? "null seen" : `other:${chunk}`);
    },
  });
  await pipeline(Readable.from(["a"]), nuller, watcher, writable);
  console.log("null stage", out.join(","));
}

{
  const { out, writable } = collect();
  const mixed = new TransformStream({
    transform(_chunk, controller) {
      controller.enqueue(null);
      controller.enqueue("after");
    },
  });
  const watcher = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk === null ? "null seen" : `other:${chunk}`);
    },
  });
  await pipeline(Readable.from(["a"]), mixed, watcher, writable);
  console.log("null then value", out.join(","));
}

{
  const { out, writable } = collect();
  const nuller = new TransformStream({
    transform(_chunk, controller) {
      controller.enqueue(null);
    },
  });
  const watcher = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk === null ? "null seen" : `other:${chunk}`);
    },
  });
  await pipeline(
    Readable.from(["a"]),
    { readable: nuller.readable, writable: nuller.writable },
    watcher,
    writable,
  );
  console.log("pair null stage", out.join(","));
}

{
  const single = compose(upper());
  const seen = [];
  single.on("data", (chunk) => seen.push(String(chunk)));
  const ended = new Promise((resolve) => single.on("end", resolve));
  single.write("ef");
  single.end();
  await ended;
  console.log("single", seen.join(","));
}

{
  const failing = () =>
    new TransformStream({
      transform() {
        throw new Error("transform boom");
      },
    });
  const outcome = await pipeline(
    Readable.from(["x"]),
    failing(),
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  ).then(
    () => "no error",
    (error) => `${error.message}`,
  );
  console.log("error", outcome);
}

{
  const slow = () =>
    new TransformStream({
      async transform(chunk, controller) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.enqueue(chunk);
      },
    });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const outcome = await pipeline(
    Readable.from(["y"]),
    slow(),
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
    { signal: controller.signal },
  ).then(
    () => "no error",
    (error) => `${error.name} ${error.code} ${error.message}`,
  );
  console.log("abort", outcome);
}

{
  const failing = () =>
    new TransformStream({
      transform() {
        throw new Error("compose boom");
      },
    });
  const { writable } = collect();
  const composed = compose(new PassThrough(), failing(), writable);
  const outcome = await new Promise((resolve) => {
    composed.on("error", (error) => resolve(error.message));
    composed.write("w");
    composed.end();
  });
  console.log("compose error", outcome);
}

try {
  const bad = compose(new Readable(), {}, new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }));
  bad.on("error", (error) => console.log("object error", error.code));
  bad.on("finish", () => console.log("object finish"));
  await new Promise((resolve) => setTimeout(resolve, 30));
} catch (error) {
  console.log("object threw", error.code, error.message);
}
