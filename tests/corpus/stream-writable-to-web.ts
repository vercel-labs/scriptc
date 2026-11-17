// Writable.toWeb: a web WritableStream over a native Writable. A writer's
// write() completes when the native write does, close() ends the writable,
// and abort() destroys it with the reason.
import { Writable } from "node:stream";

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
    (error: Error) => log.push(`finished close rejected ${error.message}`),
  );
}

main().then(() => {
  for (const line of log) console.log(line);
});
