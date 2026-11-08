// WritableStream and its default writer: the sink's start, write, close
// and abort callbacks, the writer's desiredSize, ready and closed
// promises, releaseLock and the unbound error, the constructor of a writer
// over a stream, the illegal controller constructor, a size strategy, and
// the errors sink failures carry to write, close and closed.
const events: string[] = [];

function describe(error: unknown): string {
  const err = error as Error & { code?: string };
  return err.name + " " + String(err.code) + " " + err.message;
}

async function main(): Promise<void> {
  const sink = new WritableStream<number>({
    start() {
      events.push("start");
    },
    write(chunk) {
      events.push("write " + chunk);
    },
    close() {
      events.push("close");
    },
    abort(reason) {
      events.push("abort " + reason);
    },
  });
  console.log("locked", sink.locked);
  const writer = sink.getWriter();
  console.log("writer locked", sink.locked, "desired", writer.desiredSize);
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

  const target = new WritableStream<number>({
    write(chunk) {
      console.log("target", chunk);
    },
  });
  const first = target.getWriter();
  try {
    new WritableStreamDefaultWriter<number>(target);
  } catch (e) {
    console.log("locked writer", describe(e));
  }
  first.releaseLock();
  const second = new WritableStreamDefaultWriter<number>(target);
  console.log("default writer", second.desiredSize, target.locked);
  await second.write(4);
  await second.close();

  try {
    new WritableStreamDefaultController();
  } catch (e) {
    console.log("controller", describe(e));
  }

  const sized = new WritableStream<string>(
    {
      write() {},
    },
    {
      highWaterMark: 2,
      size(chunk) {
        return chunk.length;
      },
    },
  );
  const sizedWriter = sized.getWriter();
  console.log("sized", sizedWriter.desiredSize);
  await sizedWriter.write("abc");
  console.log("sized", sizedWriter.desiredSize);

  const boom = new Error("boom");
  const failing = new WritableStream<number>({
    write() {
      throw boom;
    },
  });
  const failingWriter = failing.getWriter();
  const closed = failingWriter.closed.catch((e: unknown) => {
    console.log("closed same", e === boom);
  });
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

  const closeFails = new WritableStream<number>({
    write() {},
    close() {
      throw new Error("closefail");
    },
  });
  const closeWriter = closeFails.getWriter();
  try {
    await closeWriter.close();
  } catch (e) {
    console.log("close rejected", (e as Error).message);
  }
  try {
    await closeWriter.closed;
  } catch (e) {
    console.log("closed rejected", (e as Error).message);
  }

  const abortFails = new WritableStream<number>({
    abort() {
      throw new Error("abortfail");
    },
  });
  const abortWriter = abortFails.getWriter();
  try {
    await abortWriter.abort("stop");
  } catch (e) {
    console.log("abort rejected", (e as Error).message);
  }

  const abortReason = new Error("gone");
  const aborted = new WritableStream<number>({
    abort(reason) {
      console.log("sink abort", String(reason));
    },
  });
  const abortingWriter = aborted.getWriter();
  await abortingWriter.abort(abortReason);
  console.log("aborted locked", aborted.locked);
  try {
    await abortingWriter.write(1);
  } catch (e) {
    console.log("write after abort same", e === abortReason);
  }

  const stringAborted = new WritableStream<number>({
    abort() {},
  });
  const stringWriter = stringAborted.getWriter();
  await stringWriter.abort("because");
  try {
    await stringWriter.write(1);
  } catch (e) {
    console.log("string reason", typeof e, String(e));
  }
}

void main();
