// readable.iterator() members saved off the iterator outlive the local that
// held it: next, return and throw (bound) and [Symbol.asyncIterator] (unbound)
// called after the iteration finished answer as Node's do —
// { value: undefined, done: true } once finished, and the receiver for
// [Symbol.asyncIterator].
import { Readable } from "node:stream";

type Step = { done: boolean | undefined; value: unknown };
type Members = {
  next: () => Promise<Step>;
  ret: () => Promise<Step>;
  thr: (reason: unknown) => Promise<Step>;
  self: () => unknown;
};

const log: string[] = [];

function escape(readable: Readable): Members {
  const iterator: any = readable.iterator();
  return {
    next: iterator.next.bind(iterator),
    ret: iterator.return.bind(iterator),
    thr: iterator.throw.bind(iterator),
    self: iterator[Symbol.asyncIterator],
  };
}

// Only the unbound [Symbol.asyncIterator] survives: the iterator object itself
// is unreachable once this returns.
function escapeSelf(readable: Readable): () => unknown {
  const iterator: any = readable.iterator();
  return iterator[Symbol.asyncIterator];
}

async function main(): Promise<void> {
  const lone = escapeSelf(Readable.from(["z"]));
  const loneReceiver = { tag: "lone" };
  log.push(`lone self ${lone.call(loneReceiver) === loneReceiver}`);
  log.push(`lone self again ${lone.call(loneReceiver) === loneReceiver}`);

  const readable = Readable.from(["a", "b", "c"]);
  const members = escape(readable);
  const first = await members.next();
  log.push(`next ${first.done} ${String(first.value)}`);
  const done = await members.ret();
  log.push(`return ${done.done} ${String(done.value)} destroyed ${readable.destroyed}`);
  for (let i = 0; i < 3; i++) {
    const after = await members.next();
    log.push(`next after return ${after.done} ${String(after.value)}`);
  }
  const again = await members.ret();
  log.push(`return again ${again.done}`);
  const receiver = { tag: "receiver" };
  log.push(`self ${members.self.call(receiver) === receiver}`);

  const thrown = Readable.from(["p", "q"]);
  const thrownMembers = escape(thrown);
  await thrownMembers.next();
  await thrownMembers.thr("boom").then(
    () => log.push("throw resolved"),
    (reason: unknown) => log.push(`throw rejected ${String(reason)} destroyed ${thrown.destroyed}`),
  );
  const afterThrow = await thrownMembers.next();
  log.push(`next after throw ${afterThrow.done} ${String(afterThrow.value)}`);
  const returnAfterThrow = await thrownMembers.ret();
  log.push(`return after throw ${returnAfterThrow.done}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
