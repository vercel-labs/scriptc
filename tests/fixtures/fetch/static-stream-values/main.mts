let cancelled: unknown = "not-called";
const stream = new ReadableStream<string>({
  start(c) { c.enqueue("a"); c.enqueue("b"); c.close(); },
  cancel(reason) { cancelled = reason; },
});
const iterator = stream.values();
console.log("1", JSON.stringify(await iterator.next()));
console.log("2", JSON.stringify(await iterator.next()));
console.log("3", JSON.stringify(await iterator.next()));
console.log("4", JSON.stringify(await iterator.next()));
console.log("self", iterator[Symbol.asyncIterator]() === iterator);

const list: string[] = [];
const stream2 = ReadableStream.from(["x", "y", "z"]);
for await (const chunk of stream2.values()) list.push(chunk);
console.log("for-await", list.join(","));

let cancelReason: unknown = "none";
const stream3 = new ReadableStream<number>({
  start(c) { c.enqueue(1); c.enqueue(2); },
  cancel(reason) { cancelReason = reason; },
});
const kept = stream3.values({ preventCancel: true });
console.log("kept1", JSON.stringify(await kept.next()));
console.log("kept-return", JSON.stringify(await kept.return!("stop")));
console.log("cancel", cancelReason);
console.log("locked", stream3.locked);

const stream4 = new ReadableStream<number>({
  start(c) { c.enqueue(1); c.enqueue(2); },
  cancel(reason) { console.log("cancelled with", reason); },
});
const cancelling = stream4.values();
console.log("cancel1", JSON.stringify(await cancelling.next()));
console.log("cancel-return", JSON.stringify(await cancelling.return!("end")));

const errored = new ReadableStream<number>({ start(c) { c.error(new Error("boom")); } });
const failing = errored.values();
try { await failing.next(); } catch (e) { console.log("errored-next", (e as Error).message); }
try { await failing.next(); } catch (e) { console.log("errored-next2", (e as Error).message); }

const closed = ReadableStream.from<number>([]);
const empty = closed.values();
console.log("empty", JSON.stringify(await empty.next()));
console.log("empty2", JSON.stringify(await empty.next()));
console.log("empty3", JSON.stringify(await empty.next()));
