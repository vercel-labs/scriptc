// Response.clone and Request.clone on checked-dynamic handles: the body
// tees, so the original and the clone each read every chunk; a clone of a
// used or locked body throws; canceling both branches cancels the source
// with both reasons; the clone's headers are a copy.
const enc = new TextEncoder();
const dec = new TextDecoder();

function describe(e: unknown): string {
  const err = e as { name?: string; message?: string };
  return `${String(err.name)}: ${String(err.message)}`;
}

async function readAll(stream: any): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}

async function main(): Promise<void> {
  const r: any = new Response("hello world", { status: 201, headers: { "x-a": "1" } });
  const c: any = r.clone();
  console.log(c.status, c.headers.get("x-a"), c.bodyUsed, r.bodyUsed, c.body === r.body);
  console.log(await c.text(), "|", await r.text());
  console.log("used", c.bodyUsed, r.bodyUsed);
  try {
    r.clone();
  } catch (e) {
    console.log("clone used:", describe(e), e instanceof TypeError);
  }

  const locked: any = new Response("abc");
  locked.body.getReader();
  try {
    locked.clone();
  } catch (e) {
    console.log("clone locked:", describe(e));
  }

  const empty: any = new Response(null, { status: 204, statusText: "Nothing" });
  const emptyClone: any = empty.clone();
  console.log("null body", emptyClone.body, emptyClone.status, emptyClone.statusText, JSON.stringify(await emptyClone.text()));

  // Headers are copied: changing the clone's leaves the original's alone.
  const h: any = new Response("x", { headers: { "x-b": "2" } });
  const hc: any = h.clone();
  hc.headers.set("x-b", "3");
  console.log("headers", h.headers.get("x-b"), hc.headers.get("x-b"), h.headers === hc.headers);

  // A pulled source: both branches see each chunk (the same object).
  let n = 0;
  const source: any = new ReadableStream({
    start(): void {
      console.log("start");
    },
    pull(controller: any): void {
      n++;
      console.log("pull", n);
      if (n <= 3) controller.enqueue(enc.encode(`chunk${n};`));
      else controller.close();
    },
  });
  const streamed: any = new Response(source);
  const streamedClone: any = streamed.clone();
  console.log("cloned");
  const r1 = streamed.body.getReader();
  const r2 = streamedClone.body.getReader();
  const a = await r1.read();
  const b = await r2.read();
  console.log("same chunk", a.value === b.value, dec.decode(a.value));
  console.log("rest 1", await readAllFrom(r1));
  console.log("rest 2", await readAllFrom(r2));

  // One branch read to the end first; the other buffers.
  const big: any = new Response(new ReadableStream({
    start(controller: any): void {
      controller.enqueue(enc.encode("a"));
      controller.enqueue(enc.encode("b"));
      controller.close();
    },
  }));
  const bigClone: any = big.clone();
  console.log("clone first", await bigClone.text());
  console.log("then original", await readAll(big.body));

  // Canceling both branches cancels the source with both reasons.
  const cancelSource: any = new ReadableStream({
    pull(controller: any): void {
      controller.enqueue(enc.encode("z"));
    },
    cancel(reason: unknown): void {
      console.log("source cancel", JSON.stringify(reason));
    },
  });
  const cr: any = new Response(cancelSource);
  const crc: any = cr.clone();
  const p1 = cr.body.cancel("first");
  console.log("one canceled");
  const p2 = crc.body.cancel("second");
  await p1;
  await p2;
  console.log("both canceled", cr.bodyUsed, crc.bodyUsed);

  // An erroring source errors both branches.
  const failing: any = new ReadableStream({
    pull(controller: any): void {
      controller.error(new Error("source failed"));
    },
  });
  const fr: any = new Response(failing);
  const frc: any = fr.clone();
  for (const branch of [fr, frc]) {
    try {
      await branch.text();
    } catch (e) {
      console.log("branch error:", describe(e));
    }
  }

  // Request.clone: the body tees and the signal follows the original's.
  const q: any = new Request("http://example.test/path", { method: "POST", body: "data" });
  const qc: any = q.clone();
  console.log("request", qc.method, qc.url, await qc.text(), await q.text(), qc.signal === q.signal);
  try {
    q.clone();
  } catch (e) {
    console.log("request clone used:", describe(e));
  }
  const ac = new AbortController();
  const q2: any = new Request("http://example.test/", { signal: ac.signal });
  const q2c: any = q2.clone();
  console.log("before abort", q2c.signal.aborted);
  ac.abort("why");
  console.log("after abort", q2c.signal.aborted, q2c.signal.reason);
  const q3: any = new Request("http://example.test/", { signal: AbortSignal.abort("early") });
  console.log("aborted clone", q3.clone().signal.aborted, q3.clone().signal.reason);

  // clone is a method value like the body readers.
  console.log(typeof r.clone, "clone" in r, r.clone === c.clone);
}

async function readAllFrom(reader: any): Promise<string> {
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}


// Tee branches error when their source errors: after both buffered a
// chunk and with no source read pending, reads reject once the error's
// reaction ran (a read issued at once still takes the buffered chunk, as in
// Node); a clone of an errored body errors both branches.
async function readFirst(label: string, r: any): Promise<void> {
  try {
    const chunk = await r.body.getReader().read();
    console.log(label, "read", JSON.stringify(chunk.value ? [...chunk.value] : null), chunk.done);
  } catch (error) {
    console.log(label, "rejects", (error as Error).message);
  }
}

function erroring(): { res: any; error: (reason: Error) => void } {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(new Uint8Array([1, 2]));
    },
  });
  return { res: new Response(source), error: (reason) => ctrl!.error(reason) };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

async function sourceErrors(): Promise<void> {
  // Error, then read after the reaction: both branches reject.
  {
    const { res, error } = erroring();
    const clone = res.clone();
    await tick();
    error(new Error("late"));
    await tick();
    await readFirst("later original", res);
    await readFirst("later clone", clone);
  }
  // Error, then read at once: the first read takes the buffered chunk.
  {
    const { res, error } = erroring();
    const clone = res.clone();
    await tick();
    error(new Error("soon"));
    await readFirst("at once original", res);
    await readFirst("at once clone", clone);
  }
  // A body that errored before the clone.
  {
    const { res, error } = erroring();
    error(new Error("before"));
    const clone = res.clone();
    await readFirst("errored original", res);
    await readFirst("errored clone", clone);
  }
}

await main();
await sourceErrors();
