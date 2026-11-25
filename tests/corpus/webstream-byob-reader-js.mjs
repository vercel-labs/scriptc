// ReadableStreamBYOBReader from a JavaScript source: reads into caller
// views, the byobRequest lifecycle, respond/respondWithNewView and the
// refusals.
function describe(e) {
  if (typeof e === "string") return `string:${e}`;
  return `${e && e.code}:${e && e.message}`;
}

function id(value) {
  return value;
}

function settle(p) {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

function attempt(label, fn) {
  try {
    const value = fn();
    console.log(label, "ok", typeof value);
  } catch (e) {
    console.log(label, describe(e));
  }
}

async function main() {
  // The request's view is the caller's window; respond says how much is
  // filled, and the read answers a view of that length.
  {
    let viewLength = -1;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        const request = c.byobRequest;
        viewLength = request.view.byteLength;
        request.view.set([1, 2]);
        request.respond(2);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const end = await reader.read(new Uint8Array(4));
    console.log("view length", viewLength);
    console.log("byob", first.value, first.done, end.value, end.done);
  }

  // Two reads against one pull each answer fresh views.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        step++;
        c.byobRequest.view.set([step, step + 10]);
        c.byobRequest.respond(2);
        if (step === 2) c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const second = await reader.read(new Uint8Array(4));
    const end = await reader.read(new Uint8Array(4));
    console.log("split", first.value, second.value, end.done, step);
  }

  // min keeps a read pending until that many bytes arrive.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        step++;
        c.byobRequest.view.set([step]);
        c.byobRequest.respond(1);
        if (step === 3) c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(8), { min: 2 });
    console.log("min", result.value, result.done, step);
    reader.releaseLock();
  }

  // The view keeps the caller's element type.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.byobRequest.view.set([7, 0, 8, 0]);
        c.byobRequest.respond(4);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Int16Array(2));
    console.log("int16", result.value, result.value.constructor.name);
  }

  // The request exists only while a read waits.
  {
    let inStart = "unset";
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        inStart = c.byobRequest === null ? "null" : "present";
        c.enqueue(new Uint8Array([5]));
        c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    console.log("start request", inStart, first.value, first.done);
  }
  {
    const held = { request: null };
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        held.request = c.byobRequest;
        held.request.view.set([1]);
        held.request.respond(1);
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const request = held.request;
    console.log("first", first.value, first.done, request === held.request);
    console.log("stale view", request.view);
    attempt("stale respond", () => request.respond(1));
    attempt("stale newview", () => request.respondWithNewView(new Uint8Array(1)));
    reader.releaseLock();
    await stream.cancel();
  }

  // respond refusals; the request stays valid for the respond that
  // satisfies the read.
  {
    const log = [];
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        const request = c.byobRequest;
        for (const value of [0, NaN, 99, undefined]) {
          try {
            request.respond(value);
            log.push("ok");
          } catch (e) {
            log.push(describe(e));
          }
        }
        request.view.set([3]);
        request.respond(1);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(4));
    console.log("respond", log.join(" | "), result.value);
  }

  // respond coerces a numeric string and truncates a fraction.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.byobRequest.view.set([4, 5, 6, 7]);
        c.byobRequest.respond("2");
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(4));
    console.log("respond string", result.value);
  }

  // respondWithNewView over a subarray of the request's own view.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        const request = c.byobRequest;
        request.view.set([8, 9, 10]);
        request.respondWithNewView(request.view.subarray(0, 2));
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(4));
    console.log("newview", result.value, result.done);
  }

  // read refusals.
  {
    const stream = new ReadableStream({ type: "bytes" });
    const reader = stream.getReader({ mode: "byob" });
    console.log("read no view", await settle(reader.read()));
    console.log("read array", await settle(reader.read(id([1, 2]))));
    console.log("read string", await settle(reader.read("ab")));
    console.log("read zero", await settle(reader.read(new Uint8Array(0))));
    console.log("read min", await settle(reader.read(new Uint8Array(2), { min: 5 })));
    reader.releaseLock();
    await stream.cancel();
  }

  // A closed stream answers an empty view and done.
  {
    const stream = new ReadableStream({ type: "bytes" });
    await stream.cancel();
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(3));
    console.log("closed", result.value, result.done);
  }

  // A released reader refuses further reads.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    reader.releaseLock();
    console.log("released", await settle(reader.read(new Uint8Array(2))));
  }

  // Reader and controller identity and members.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        console.log(
          "controller",
          c.constructor.name,
          c instanceof ReadableByteStreamController,
          "byobRequest" in c,
          c.desiredSize,
          "getReader" in c,
        );
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    console.log(
      "reader",
      reader.constructor.name,
      reader instanceof ReadableStreamBYOBReader,
      "read" in reader,
      "closed" in reader,
      "cancel" in reader,
      "view" in reader,
    );
    reader.releaseLock();
    await stream.cancel();
  }
}

main();
