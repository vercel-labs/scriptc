// readable.iterator(): the async iterator over a readable's chunks —
// next() answers { value, done }, return() completes it (destroying the
// readable unless destroyOnReturn is false), throw() destroys with the value
// and rejects with it, and the iterator is its own async iterable.
import { Readable } from "node:stream";

const log: string[] = [];

async function main(): Promise<void> {
  const readable = Readable.from(["a", "b"]);
  const iterator: any = readable.iterator();
  log.push(`self ${iterator[Symbol.asyncIterator]() === iterator}`);
  const first = await iterator.next();
  log.push(`first ${first.done} ${String(first.value)}`);
  const done = await iterator.return();
  log.push(`return ${done.done} ${String(done.value)} destroyed ${readable.destroyed}`);
  const again = await iterator.next();
  log.push(`after return ${again.done}`);

  const kept = Readable.from(["x", "y"]);
  const keptIterator: any = kept.iterator({ destroyOnReturn: false });
  log.push(`kept first ${String((await keptIterator.next()).value)}`);
  const keptDone = await keptIterator.return();
  log.push(`kept return ${keptDone.done} destroyed ${kept.destroyed} rest ${String(await kept.read())}`);

  const thrown = Readable.from(["p"]);
  const thrownIterator: any = thrown.iterator();
  await thrownIterator.next();
  await thrownIterator.throw("boom").then(
    () => log.push("throw resolved"),
    (reason: unknown) => log.push(`throw rejected ${String(reason)} destroyed ${thrown.destroyed}`),
  );

  const iterated = Readable.from(["m", "n"]);
  const seen: string[] = [];
  const iteratedIterator: any = iterated.iterator();
  for await (const chunk of iteratedIterator) seen.push(String(chunk));
  log.push(`iterated ${seen.join(",")}`);
}

main().then(() => {
  for (const line of log) console.log(line);
});
