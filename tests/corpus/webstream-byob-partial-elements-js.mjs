// ReadableStreamBYOBReader over multi-byte views: `min` counts elements, a
// read answers whole elements and leaves the trailing bytes for the next
// one, respondWithNewView continues the destination it already holds, and a
// close that waited for the queue takes effect when its last bytes are read.

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
  // min counts elements of the view's type: two elements of a Uint32Array
  // are eight bytes, so the read takes two four-byte responses.
  {
    let pulls = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        pulls++;
        const view = c.byobRequest.view;
        const take = Math.min(4, view.byteLength);
        for (let i = 0; i < take; i++) view[i] = (pulls - 1) * 4 + i + 1;
        c.byobRequest.respond(take);
        if (pulls === 2) c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint32Array(2), { min: 2 });
    console.log(
      "min-elements",
      result.done,
      result.value.length,
      result.value.constructor.name,
      pulls,
      result.value[0],
      result.value[1],
    );
  }

  // A read answers whole elements only: the bytes past the last one stay in
  // the stream for the read that follows.
  {
    let controller;
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        controller = c;
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
    const first = await reader.read(new Uint32Array(1));
    console.log("whole", first.value.length, first.value[0]);
    const second = reader.read(new Uint32Array(1));
    controller.enqueue(new Uint8Array([7, 8]));
    const rest = await second;
    console.log("carried", rest.value.length, rest.value[0]);
    controller.close();
  }

  // respondWithNewView over part of the request's view fills the read's own
  // destination; the next pull answers only the bytes still missing.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        step++;
        if (step === 1) {
          const view = c.byobRequest.view;
          view.set([1, 2, 3, 4]);
          c.byobRequest.respondWithNewView(view.subarray(0, 2));
        } else {
          const view = c.byobRequest.view;
          console.log("newview rest", view.byteLength);
          view.set([3, 4]);
          c.byobRequest.respond(2);
          c.close();
        }
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint32Array(1));
    console.log("newview", result.done, result.value.length, result.value[0], step);
  }

  // A close that waited for the queue takes effect when the last queued
  // bytes are read: the next read answers the end, and reader.closed settles.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4]));
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const second = await reader.read(new Uint8Array(4));
    let closed = "pending";
    reader.closed.then(() => {
      closed = "closed";
    });
    await tick();
    console.log("drain-close", first.done, first.value.length, second.done, second.value.length, closed);
  }

  // Queued bytes the close leaves behind cannot fill the read: the stream
  // errors with Node's closed-stream error and the read answers it.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    let outcome = "pending";
    await reader.read(new Uint32Array(2)).then(
      (result) => {
        outcome = `read ${result.done} ${result.value.length}`;
      },
      (e) => {
        outcome = `read ${e.constructor.name} ${e.code} ${e.message}`;
      },
    );
    let closed = "pending";
    await reader.closed.then(
      () => {
        closed = "closed";
      },
      (e) => {
        closed = `rejected ${e.constructor.name} ${e.code} ${e.message}`;
      },
    );
    console.log("insufficient", outcome);
    console.log("insufficient closed", closed);
  }

  // A read takes every byte the queue can give it before it answers, so the
  // bytes a later queued chunk holds for the next read stay after the bytes
  // this read already holds.
  {
    let controller;
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        controller = c;
        c.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
        c.enqueue(new Uint8Array([7, 8, 9, 10]));
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint32Array(2));
    const firstBytes = new Uint8Array(first.value.buffer, first.value.byteOffset, first.value.byteLength);
    console.log("queue-fill", first.done, first.value.length, Array.from(firstBytes).join(","));
    controller.close();
    const second = await reader.read(new Uint8Array(8));
    console.log("queue-fill rest", second.done, second.value.length, Array.from(second.value).join(","));
  }
}

main();
