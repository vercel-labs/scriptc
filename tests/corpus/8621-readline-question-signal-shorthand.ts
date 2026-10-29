// node:readline/promises question() with the SHORTHAND options object
// `{ signal }`: the shorthand names a local whose type is
// `AbortSignal | undefined`. An absent signal behaves like no signal, a
// live one answers normally, aborting it while the question is pending
// rejects with Node's AbortError, and a pre-aborted signal rejects before
// the prompt is written. The same shapes as the longhand
// `{ signal: value }` form, whose behavior pins here.
import * as readline from "node:readline/promises";
import { PassThrough, Readable } from "node:stream";

const out = new PassThrough();
out.on("data", (c: Buffer) => console.log("output:", JSON.stringify(c.toString())));

function describe(e: unknown): string {
  const err = e as Error;
  const code = (e as { code?: string }).code;
  const reason = err.cause;
  const cause = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return `${err.name} ${code} "${err.message}" cause=${cause}`;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: new Readable({ read() {} }), output: out });

  // A shorthand signal that is absent at runtime: the question behaves as
  // if no options were passed and accepts the next line.
  const absent: AbortSignal | undefined = undefined;
  const plain = rl.question("absent? ", { signal: absent });
  rl.write("first\n");
  console.log("absent answered:", await plain);

  // A shorthand signal that is live: the answer comes through, and the
  // abort after settlement changes nothing.
  const controller = new AbortController();
  const live: AbortSignal | undefined = controller.signal;
  const answered = rl.question("live? ", { signal: live });
  rl.write("second\n");
  console.log("live answered:", await answered);
  controller.abort();

  // Aborting the shorthand signal while the question is pending rejects it
  // with the signal's reason as the cause.
  const pendingController = new AbortController();
  const signal = pendingController.signal;
  const pending = rl.question("abort? ", { signal });
  pendingController.abort();
  try {
    await pending;
    console.log("unreachable abort");
  } catch (e) {
    console.log("aborted:", describe(e));
  }

  // A pre-aborted shorthand signal rejects before the prompt is written.
  const early = new AbortController();
  early.abort("why");
  const earlySignal: AbortSignal | undefined = early.signal;
  try {
    await rl.question("early? ", { signal: earlySignal });
    console.log("unreachable early");
  } catch (e) {
    console.log("pre-aborted:", describe(e));
  }

  rl.close();
}

await main();
