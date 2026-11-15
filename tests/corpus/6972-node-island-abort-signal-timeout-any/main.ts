// @requires-libnode
// Native signals that abort on their own, handed to a Node island:
// AbortSignal.timeout(ms), and AbortSignal.any([...]) over native signals,
// including one the program keeps no reference to. An island signal and a
// native one combine through the island's AbortSignal.any.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

async function main(): Promise<void> {
  // A timeout signal's timer does not keep the program alive: this does.
  const alive = setInterval(() => {}, 1000);

  // A timeout the program holds, and one only the island holds.
  const timeout = AbortSignal.timeout(20);
  console.log("timeout is a signal", lib.isSignal(timeout));
  const held: Promise<string> = lib.whenAborted("timeout", timeout);
  const dropped: Promise<string> = lib.whenAborted("dropped timeout", AbortSignal.timeout(30));
  console.log(await held, timeout.aborted, (timeout.reason as Error).name);
  console.log(await dropped);

  // AbortSignal.any over two controllers: the second source aborts.
  const a = new AbortController();
  const b = new AbortController();
  const either = AbortSignal.any([a.signal, b.signal]);
  const eitherDone: Promise<string> = lib.whenAborted("any", either);
  b.abort(new Error("b first"));
  console.log(await eitherDone, either.aborted, a.signal.aborted);

  // The combined signal exists only as the argument: the island keeps its
  // twin, and the source still reaches it.
  const source = new AbortController();
  const temporary: Promise<string> = lib.whenAborted(
    "temporary any",
    AbortSignal.any([source.signal, AbortSignal.timeout(60_000)]),
  );
  source.abort("source");
  console.log(await temporary);

  // any() of an aborted source crosses aborted.
  console.log(await lib.whenAborted("aborted any", AbortSignal.any([AbortSignal.abort("was")])));

  // A native signal and an island signal, combined on the island.
  const native = new AbortController();
  const island = lib.makeController();
  const combined = lib.combine(native.signal, island.signal);
  const combinedDone: Promise<string> = lib.whenAborted("combined", combined);
  console.log("combined before", combined.aborted);
  island.abort("island side");
  console.log(await combinedDone, combined.aborted, native.signal.aborted);
  const second = lib.combine(native.signal, lib.makeController().signal);
  const secondDone: Promise<string> = lib.whenAborted("combined again", second);
  native.abort("native side");
  console.log(await secondDone, second.aborted);
  clearInterval(alive);
}

main();
