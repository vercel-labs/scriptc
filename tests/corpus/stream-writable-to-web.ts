// Writable.toWeb: a web WritableStream over a native Writable. A writer's
// write() completes when the native write does, close() ends the writable,
// and abort() destroys it with the reason.
import { Duplex, Writable, finished } from "node:stream";

const log: string[] = [];
const encoder = new TextEncoder();

async function main(): Promise<void> {
  const written: string[] = [];
  const native = new Writable({
    write(chunk, encoding, done): void {
      written.push(String(chunk));
      done();
    },
  });
  const web = Writable.toWeb(native);
  log.push(`stream ${typeof web.getWriter === "function"}`);
  const writer = web.getWriter();
  await writer.write(encoder.encode("ab"));
  log.push(`after write ${written.join("|")} length ${native.writableLength}`);
  await writer.close();
  log.push(`closed ended ${native.writableEnded} finished ${native.writableFinished}`);

  const destroying = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
  });
  destroying.on("error", () => log.push("error event"));
  const web2 = Writable.toWeb(destroying);
  const writer2 = web2.getWriter();
  await writer2.abort("stop");
  log.push(`aborted destroyed ${destroying.destroyed}`);
  // The reason reaches the writable's 'error' event on the next tick.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));

  // The same abort with no listener on the writable: the adapter consumes the
  // lifecycle 'error' (Node's eos watcher does) instead of crashing.
  const silent = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
  });
  const web3 = Writable.toWeb(silent);
  await web3.getWriter().abort(new Error("halt")).then(
    () => log.push("silent abort resolved"),
    (error: Error) => log.push(`silent abort rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  log.push(`silent destroyed ${silent.destroyed} errored ${silent.errored?.message}`);

  // A writable with autoDestroy: false finishes without emitting 'close'; the
  // writer's close still settles at the finish.
  const lasting = new Writable({
    autoDestroy: false,
    write(chunk, encoding, done): void {
      done();
    },
  });
  const web5 = Writable.toWeb(lasting);
  const writer5 = web5.getWriter();
  await writer5.write(encoder.encode("q"));
  await writer5.close().then(
    () => log.push("no-autodestroy close resolved"),
    (error: Error) => log.push(`no-autodestroy close rejected ${error.message}`),
  );
  log.push(`no-autodestroy finished ${lasting.writableFinished} destroyed ${lasting.destroyed}`);

  // A failed native write resolves the writer's promise, as Node's adapter
  // does; the failure reaches the stream's lifecycle.
  const failing = new Writable({
    write(chunk, encoding, done): void {
      done(new Error("sink fail"));
    },
  });
  const failingWeb = Writable.toWeb(failing);
  await failingWeb.getWriter().write(encoder.encode("x")).then(
    () => log.push("failed write resolved"),
    (error: Error) => log.push(`failed write rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // The same failed write resolves when the callback fails synchronously.
  const syncFailing = new Writable({
    write(chunk, encoding, done): void {
      done(new Error("sync sink fail"));
    },
  });
  const syncFailingWeb = Writable.toWeb(syncFailing);
  await syncFailingWeb.getWriter().write(encoder.encode("x")).then(
    () => log.push("sync failed write resolved"),
    (error: Error) => log.push(`sync failed write rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // A write the writable backpressured (its chunk is queued past the high
  // water mark) rejects the writer's write with the stream's error when the
  // write then fails, as Node's adapter's drain-or-error promise does.
  const slowFailing = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, done): void {
      setTimeout(() => done(new Error("slow sink fail")), 5);
    },
  });
  const slowFailingWeb = Writable.toWeb(slowFailing);
  await slowFailingWeb.getWriter().write(encoder.encode("xy")).then(
    () => log.push("backpressured failed write resolved"),
    (error: Error) => log.push(`backpressured failed write rejected ${error.message}`),
  );
  log.push(`backpressured errored ${slowFailing.errored?.message}`);

  // Closing after the writable's accepted write failed rejects with the
  // invalid state the errored web stream has, even when autoDestroy: false
  // leaves the writable undestroyed.
  const noDestroy = new Writable({
    autoDestroy: false,
    write(chunk, encoding, done): void {
      setTimeout(() => done(new Error("no destroy fail")), 5);
    },
  });
  const noDestroyWeb = Writable.toWeb(noDestroy);
  const noDestroyWriter = noDestroyWeb.getWriter();
  await noDestroyWriter.write(encoder.encode("x")).then(
    () => log.push("no-autodestroy failed write resolved"),
    (error: Error) => log.push(`no-autodestroy failed write rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await noDestroyWriter.close().then(
    () => log.push("no-autodestroy failed close resolved"),
    (error: Error & { code?: string }) =>
      log.push(`no-autodestroy failed close rejected ${error.name} ${error.code}`),
  );

  // A close already waiting when the write fails keeps the write's error.
  const pendingCloseFail = new Writable({
    autoDestroy: false,
    write(chunk, encoding, done): void {
      setTimeout(() => done(new Error("pending close fail")), 5);
    },
  });
  const pendingCloseFailWeb = Writable.toWeb(pendingCloseFail);
  const pendingCloseFailWriter = pendingCloseFailWeb.getWriter();
  await pendingCloseFailWriter.write(encoder.encode("x"));
  await pendingCloseFailWriter.close().then(
    () => log.push("pending close resolved"),
    (error: Error) => log.push(`pending close rejected ${error.message}`),
  );

  // A backpressured write that succeeds resolves the writer's write at the
  // writable's 'drain'.
  const slowOk = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, done): void {
      setTimeout(done, 5);
    },
  });
  const slowOkWeb = Writable.toWeb(slowOk);
  const slowOkWriter = slowOkWeb.getWriter();
  await slowOkWriter.write(encoder.encode("xy")).then(
    () => log.push("backpressured write resolved"),
    (error: Error) => log.push(`backpressured write rejected ${error.message}`),
  );
  await slowOkWriter.close();

  // Destroying the writable while its backpressured write pends rejects the
  // writer's write with Node's AbortError.
  const halted = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, done): void {
      setTimeout(done, 50);
    },
  });
  const haltedWeb = Writable.toWeb(halted);
  const haltedWrite = haltedWeb.getWriter().write(encoder.encode("xy")).then(
    () => log.push("destroyed write resolved"),
    (error: Error & { code?: string }) =>
      log.push(`destroyed write rejected ${error.name} ${error.message} ${error.code}`),
  );
  setTimeout(() => halted.destroy(), 5);
  await haltedWrite;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  // Once an accepted write has failed, the stream is errored: a later write
  // rejects with the same error without reaching the writable.
  const failedTwice = new Writable({
    write(chunk, encoding, done): void {
      setTimeout(() => done(new Error("twice fail")), 5);
    },
  });
  const failedTwiceWeb = Writable.toWeb(failedTwice);
  const failedTwiceWriter = failedTwiceWeb.getWriter();
  await failedTwiceWriter.write(encoder.encode("x")).then(
    () => log.push("twice first write resolved"),
    (error: Error) => log.push(`twice first write rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await failedTwiceWriter.write(encoder.encode("y")).then(
    () => log.push("twice second write resolved"),
    (error: Error) => log.push(`twice second write rejected ${error.message}`),
  );

  // A writable destroyed without an error gave the stream an AbortError: a
  // later write rejects with it.
  const gone = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
  });
  const goneWeb = Writable.toWeb(gone);
  const goneWriter = goneWeb.getWriter();
  gone.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await goneWriter.write(encoder.encode("z")).then(
    () => log.push("destroyed writable write resolved"),
    (error: Error & { code?: string }) =>
      log.push(`destroyed writable write rejected ${error.name} ${error.code}`),
  );

  // Destroying the writable while the writer's close is pending settles the
  // close instead of leaving it waiting for an event that never comes.
  const slowFinal = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
    final(done): void {
      setTimeout(done, 20);
    },
  });
  const slowWeb = Writable.toWeb(slowFinal);
  const slowWriter = slowWeb.getWriter();
  await slowWriter.write(encoder.encode("y"));
  const pendingClose = slowWriter.close().then(
    () => log.push("close after destroy resolved"),
    (error: Error) => log.push(`close after destroy rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  slowFinal.destroy();
  await pendingClose;

  // Closing over a writable that already finished settles: there is no
  // terminal event left to wait for.
  const finishedWritable = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
  });
  finishedWritable.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const finishedWeb = Writable.toWeb(finishedWritable);
  await finishedWeb.getWriter().close().then(
    () => log.push("finished close resolved"),
    (error: Error & { code?: string }) =>
      log.push(`finished close rejected ${error.name} ${error.code} ${error.message}`),
  );

  // A native writable ended while its web stream is open ends the adapter
  // that way too: Node errors the web stream with an AbortError, so a later
  // write rejects with it.
  const endedLater = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
  });
  const endedWeb = Writable.toWeb(endedLater);
  const endedWriter = endedWeb.getWriter();
  endedLater.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await endedWriter.write(encoder.encode("x")).then(
    () => log.push("write after end resolved"),
    (error: Error & { code?: string }) =>
      log.push(`write after end rejected ${error.name} ${error.code ?? "-"}`),
  );

  // An accepted write that fails later leaves the adapter errored: the next
  // write rejects with the stream's error instead of being accepted.
  const failingOnce = new Writable({
    write(chunk, encoding, done): void {
      setTimeout(() => done(new Error("first")), 5);
    },
  });
  failingOnce.on("error", () => {});
  const onceWriter = Writable.toWeb(failingOnce).getWriter();
  await onceWriter.write(encoder.encode("a")).then(
    () => log.push("accepted write resolved"),
    (error: Error) => log.push(`accepted write rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await onceWriter.write(encoder.encode("b")).then(
    () => log.push("write after failure resolved"),
    (error: Error) => log.push(`write after failure rejected ${error.message}`),
  );

  // A Duplex adapts like a Writable: its writer's close settles at the
  // stream's end-of-stream, which waits for the readable half too (here it
  // ends after the writable side finished).
  const duplex = new Duplex({
    autoDestroy: false,
    read(): void {
      setTimeout(() => this.push(null), 10);
    },
    write(chunk, encoding, done): void {
      done();
    },
  });
  duplex.resume();
  const duplexWeb = Writable.toWeb(duplex);
  const duplexWriter = duplexWeb.getWriter();
  await duplexWriter.write(encoder.encode("d"));
  await duplexWriter.close().then(
    () => log.push("duplex close resolved"),
    (error: Error) => log.push(`duplex close rejected ${error.message}`),
  );
  log.push(`duplex finished ${duplex.writableFinished} destroyed ${duplex.destroyed}`);

  // An error the writable emits itself is consumed by the adapter and fails
  // the writer instead of escaping as an unhandled error.
  const emitting = new Writable({
    write(chunk, encoding, done): void {
      done();
    },
  });
  const emittingWriter = Writable.toWeb(emitting).getWriter();
  emitting.emit("error", new Error("emitted"));
  await emittingWriter.write(encoder.encode("e")).then(
    () => log.push("write after emitted error resolved"),
    (error: Error) => log.push(`write after emitted error rejected ${error.message}`),
  );
  emitting.destroy();

  // A write still waiting on backpressure when the writable ends cleanly
  // settles (the drain it waited for happens as the queue empties).
  const endingBp = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, done): void {
      setTimeout(done, 5);
    },
  });
  const endingBpWriter = Writable.toWeb(endingBp).getWriter();
  const endingWrite = endingBpWriter.write(encoder.encode("xy"));
  endingBp.end();
  await endingWrite.then(
    () => log.push("backpressured end resolved"),
    (error: Error) => log.push(`backpressured end rejected ${error.message}`),
  );

  // abort() with no reason errors the writable with an AbortError, which the
  // adapter consumes and retires on even though this writable never emits
  // 'close'.
  const quiet = new Writable({
    emitClose: false,
    write(chunk, encoding, done): void {
      done();
    },
  });
  const quietWriter = Writable.toWeb(quiet).getWriter();
  await quietWriter.abort().then(
    () => log.push("quiet abort resolved"),
    (error: Error) => log.push(`quiet abort rejected ${error.message}`),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  log.push(`quiet destroyed ${quiet.destroyed} errored ${quiet.errored?.message ?? "-"}`);
  await quietWriter.write(encoder.encode("z")).then(
    () => log.push("write after quiet abort resolved"),
    (error: (Error & { name: string }) | undefined) =>
      log.push(`write after quiet abort rejected ${error ? error.name : "undefined"}`),
  );

  // A destroy with no error on a writable that never emits 'close': a later
  // write resolves and a later close stays pending, as Node leaves them.
  const quietDestroy = new Writable({
    emitClose: false,
    write(chunk, encoding, done): void {
      done();
    },
  });
  const quietDestroyWriter = Writable.toWeb(quietDestroy).getWriter();
  await quietDestroyWriter.write(encoder.encode("q"));
  quietDestroy.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await quietDestroyWriter.write(encoder.encode("r")).then(
    () => log.push("write after quiet destroy resolved"),
    (error: Error) => log.push(`write after quiet destroy rejected ${error.message}`),
  );
  const quietClose = await Promise.race([
    quietDestroyWriter.close().then(
      () => "resolved",
      (error: Error) => `rejected ${error.message}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
  log.push(`close after quiet destroy ${quietClose}`);

  // A user finished() watcher on that silent destroy stays pending, as Node
  // leaves it, even with an adapter attached to the same writable.
  const watchQuiet = new Writable({
    emitClose: false,
    write(chunk, encoding, done): void {
      done();
    },
  });
  const watchQuietWriter = Writable.toWeb(watchQuiet).getWriter();
  await watchQuietWriter.write(encoder.encode("s"));
  let watchCalled = false;
  finished(watchQuiet, () => {
    watchCalled = true;
  });
  watchQuiet.destroy();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  log.push(`finished after quiet destroy called ${watchCalled}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
