// @requires-libnode
// A native AbortSignal handed to a Node island is a real AbortSignal of the
// island's realm, and it follows the native one: island code that tests a
// signal's brand accepts it, and when the program aborts, the island's
// listeners run, `aborted` and `reason` change, and Node's own receivers of
// the signal (events.once, timers/promises, AbortSignal.any) react.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface RequestOptions {
  signal?: AbortSignal;
  retries: number;
}

async function main(): Promise<void> {
  // As an argument, aborted with a string.
  const first = new AbortController();
  console.log("brand", lib.describe(first.signal));
  lib.watch("first", first.signal);
  console.log("before", lib.state(first.signal));
  console.log("not aborted", lib.throwIfAborted(first.signal));
  first.abort("stop");
  console.log("after", lib.state(first.signal), first.signal.aborted, first.signal.reason);
  console.log("aborted", lib.throwIfAborted(first.signal));
  // A second abort changes nothing on either side.
  first.abort("again");
  console.log("again", lib.state(first.signal), first.signal.reason);

  // As a property of a record the island copies, aborted with an Error.
  const second = new AbortController();
  const options: RequestOptions = { signal: second.signal, retries: 2 };
  const pending: Promise<string> = lib.request(options);
  second.abort(new RangeError("cancelled"));
  try {
    console.log(await pending);
  } catch (error) {
    console.log("request rejected", error instanceof RangeError, (error as Error).message);
  }
  const plain: RequestOptions = { retries: 3 };
  console.log(await lib.request(plain));

  // Aborted with no reason, a number, null and an object of the program.
  const third = new AbortController();
  lib.watch("third", third.signal);
  third.abort();
  const fourth = new AbortController();
  lib.watch("fourth", fourth.signal);
  fourth.abort(42);
  const fifth = new AbortController();
  lib.watch("fifth", fifth.signal);
  fifth.abort(null);
  const sixth = new AbortController();
  lib.watch("sixth", sixth.signal);
  const why = { code: "E_STOP", detail: [1, 2] };
  sixth.abort(why);
  console.log("object reason", JSON.stringify(sixth.signal.reason));

  // The island's listener forms.
  const seventh = new AbortController();
  const report: () => string = lib.listeners(seventh.signal);
  seventh.abort("forms");
  console.log("forms", report());

  // Node's receivers.
  const eighth = new AbortController();
  const apis = lib.nodeApis(eighth.signal);
  console.log("any before", apis.any.aborted, "disposable", apis.disposable);
  eighth.abort(new Error("enough"));
  console.log("any after", apis.any.aborted, String(apis.any.reason));
  console.log("once", await apis.once);
  console.log("sleep", await apis.sleep);
}

main();
