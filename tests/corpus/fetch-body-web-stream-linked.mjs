// Fetch Response and Request bodies as web ReadableStreams in a program
// that also names the classes: tee, pipeTo, pipeThrough, values and
// for await on a body, the body's lock and bodyUsed across them, and the
// body's other uses (text, clone, a new Response) after one.
const decoder = new TextDecoder();
const text = (chunks) => chunks.map((c) => decoder.decode(c)).join("");
const settled = (p) => p.then((v) => `ok:${v}`, (e) => `${e.name}:${e.message}`);
const caught = (fn) => {
  try {
    return `ok:${fn()}`;
  } catch (e) {
    return `${e.name}:${e.message}`;
  }
};
// Response.clone runs on checked-dynamic handles; the clone goes through
// an untyped parameter.
const cloneOf = (value) => value.clone();
const readAll = async (stream) => {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text(chunks);
    chunks.push(value);
  }
};

{
  const response = new Response("tee body");
  const body = response.body;
  console.log("members", typeof body.tee, typeof body.pipeTo, typeof body.pipeThrough, typeof body.values, "tee" in body, body instanceof ReadableStream);
  console.log("before", body.locked, response.bodyUsed);
  const [a, b] = body.tee();
  console.log("teed", body.locked, response.bodyUsed, a instanceof ReadableStream, response.body === body);
  console.log("branches", await readAll(a), await readAll(b), response.bodyUsed);
  console.log("used", await settled(response.text()), caught(() => body.tee()));
}

{
  const chunks = [];
  const response = new Response("piped");
  await response.body.pipeTo(new WritableStream({ write(c) { chunks.push(c); } }));
  console.log("pipeTo", text(chunks), response.bodyUsed, response.body.locked);
}

{
  const upper = new TransformStream({ transform(chunk, c) { c.enqueue(decoder.decode(chunk).toUpperCase()); } });
  const out = new Response("through").body.pipeThrough(upper);
  const reader = out.getReader();
  console.log("pipeThrough", (await reader.read()).value, (await reader.read()).done);
}

{
  const request = new Request("http://example.com/", { method: "POST", body: "iterate me", duplex: "half" });
  let joined = "";
  for await (const chunk of request.body) joined += decoder.decode(chunk);
  console.log("for await", joined, request.bodyUsed, request.body.locked);
  const values = [];
  for await (const chunk of new Response("values").body.values()) values.push(decoder.decode(chunk));
  console.log("values", values.join("|"));
  const early = new Response("early");
  for await (const chunk of early.body) {
    console.log("break", chunk.length);
    break;
  }
  console.log("after break", early.bodyUsed, early.body.locked, await settled(early.text()));
}

{
  const response = new Response("read first");
  const reader = response.body.getReader();
  console.log("reader first", caught(() => { response.body.tee(); return "teed"; }), response.body.locked);
  reader.releaseLock();
  const [a] = response.body.tee();
  console.log("after release", response.body.locked, await readAll(a));
}

{
  const response = new Response("member value");
  const tee = response.body.tee;
  console.log("method value", tee === ReadableStream.prototype.tee, Array.isArray(tee.call(response.body)), response.body.locked);
  const viewed = new Response("viewed");
  void viewed.body.values;
  console.log("viewed text", viewed.body.locked, viewed.bodyUsed, await viewed.text(), viewed.bodyUsed, viewed.body.locked);
  const cloned = new Response("cloned");
  void cloned.body.tee;
  const copy = cloneOf(cloned);
  console.log("viewed clone", await copy.text(), await cloned.text());
  const source = new Response("rewrapped");
  void source.body.pipeTo;
  const rewrapped = new Response(source.body);
  console.log("rewrapped", source.bodyUsed, await rewrapped.text(), source.bodyUsed);
}

{
  // Starting a read, a cancel, a pipe or an iteration on the body's stream
  // updates bodyUsed when it starts, as in Node.
  const read = new Response("read now");
  void read.body.values;
  const pending = read.body.getReader().read();
  console.log("bodyUsed read", read.bodyUsed);
  await pending;
  const canceled = new Response("cancel now");
  void canceled.body.tee;
  const cancel = canceled.body.cancel("why");
  console.log("bodyUsed cancel", canceled.bodyUsed);
  await cancel;
  const piped = new Response("pipe now");
  const pipe = piped.body.pipeTo(new WritableStream());
  console.log("bodyUsed pipe", piped.bodyUsed, piped.body.locked);
  await pipe;
  const iterated = new Response("iterate now");
  const step = iterated.body.values().next();
  console.log("bodyUsed next", iterated.bodyUsed);
  await step;
}
