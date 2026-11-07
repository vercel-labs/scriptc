// The object a web stream read answers with. Node builds it in two orders:
// a read() or next() that finds a chunk already queued answers
// { done, value }, and one that has to wait for the chunk, or meets the
// end, answers { value, done }; the iterator's own end is { done, value }.
// Programs see the order through Object.keys, JSON.stringify and spreads.
const shape = (result) => `${Object.keys(result).join(",")} ${JSON.stringify(result)}`;

// Chunks queued before read() is called, then the end.
{
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
  const reader = stream.getReader();
  console.log("queued", shape(await reader.read()), "|", shape(await reader.read()));
  console.log("end", shape(await reader.read()), "|", shape(await reader.read()));
}

// read() called before the chunk arrives, and before the close.
{
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const reader = stream.getReader();
  const first = reader.read();
  const second = reader.read();
  controller.enqueue("a");
  controller.close();
  console.log("waiting", shape(await first), "|", shape(await second));
}

// A queued chunk next to a waiting read: one of each.
{
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue(1);
    },
  });
  const reader = stream.getReader();
  const queued = reader.read();
  const waiting = reader.read();
  controller.enqueue(2);
  console.log("mixed", shape(await queued), "|", shape(await waiting));
  reader.releaseLock();
  await stream.cancel();
}

// tee(): the first branch's read waits for the source, the second finds
// the chunk the first one pulled.
{
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.close();
    },
  });
  const [left, right] = stream.tee();
  console.log("tee", shape(await left.getReader().read()), "|", shape(await right.getReader().read()));
}

// The async iterator: the first next() waits a turn, a later one finds
// the queue, and the end is the iterator's own.
{
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
  const iterator = stream.values();
  console.log("iterator", shape(await iterator.next()), "|", shape(await iterator.next()));
  console.log("iterator end", shape(await iterator.next()), "|", shape(await iterator.next()));
}

// A spread keeps the order it was given.
{
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.close();
    },
  });
  const reader = stream.getReader();
  const copy = { ...(await reader.read()), extra: true };
  console.log("spread", JSON.stringify(copy));
}
