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
}

main().then(() => {
  for (const line of log) console.log(line);
});
