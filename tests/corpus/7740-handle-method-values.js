// Methods of native Web objects read as values in untyped code: hono's
// HonoRequest calls `raw[key]()` with a computed body-method name, and code
// probes `typeof x.json` or `"get" in headers`. Each method is one shared
// function that runs on its `this`; another receiver fails Node's brand check.
const report = (label, e) => console.log(label, e.name, e.message, e.code);
// An untyped holder, as values reach a JavaScript library.
const untyped = (value) => {
  const holder = JSON.parse("{}");
  holder.value = value;
  return holder.value;
};

async function bodies() {
  const holder = JSON.parse("{}");
  holder.req = new Request("http://example.test/books", { method: "POST", body: '{"title":"Dune"}' });
  const cache = {};
  const cachedBody = (key) => {
    const raw = holder.req;
    if (cache[key]) return cache[key];
    return (cache[key] = raw[key]());
  };
  console.log(await cachedBody("json"));
  for (const key of ["text", "arrayBuffer", "bytes"]) {
    const res = new Response("abc");
    const value = await res[key]();
    console.log(key, typeof value, value instanceof ArrayBuffer, value.length ?? value.byteLength);
  }
}

function shape() {
  const req = JSON.parse("{}");
  req.value = new Request("http://example.test/");
  const r = req.value;
  console.log(typeof r.json, typeof r.text, typeof r.blobby, typeof r.url);
  console.log("json" in r, "url" in r, "toString" in r, "missing" in r);
  const other = JSON.parse("{}");
  other.res = new Response("x");
  console.log(r.json === r.json, r.json === other.res.json, r.json === r.text);
  console.log(r.json.name, r.json.length, r.arrayBuffer.name);
  const box = { h: untyped(new Headers({ a: "1" })) };
  console.log(box.h.append.length, box.h.forEach.length, box.h.get.name, "has" in box.h, "nope" in box.h);
  const name = "get";
  console.log(box.h[name]("a"), box.h["has"]("b"));
  box.h["set"]("b", "2");
  const entries = [];
  box.h["forEach"]((v, k) => entries.push(k + "=" + v));
  console.log(entries.join(","));
}

async function receivers() {
  const box = {
    h: untyped(new Headers({ a: "1" })),
    req: untyped(new Request("http://example.test/", { method: "POST", body: "x" })),
  };
  const get = box.h.get;
  console.log(get.call(box.h, "a"), get.bind(box.h)("a"), get.apply(box.h, ["a"]));
  try {
    get("a");
  } catch (e) {
    report("unbound get", e);
  }
  try {
    get.call(box.req, "a");
  } catch (e) {
    report("foreign get", e);
  }
  const text = box.req.text;
  const pending = text();
  console.log("text returns", pending instanceof Promise);
  await pending.then(
    () => console.log("unexpected"),
    (e) => report("unbound text", e),
  );
  await text.call(box.h).catch((e) => report("foreign text", e));
  console.log(await text.call(box.req));
  const signal = { s: untyped(new AbortController().signal) };
  const throwIfAborted = signal.s.throwIfAborted;
  try {
    throwIfAborted();
  } catch (e) {
    report("unbound throwIfAborted", e);
  }
  try {
    signal.s.addEventListener.call(box.h, "abort", () => {});
  } catch (e) {
    report("foreign addEventListener", e);
  }
  // The signal's EventTarget methods are EventTarget's own: one function
  // shared with every target, which runs on any EventTarget receiver.
  const target = untyped(new EventTarget());
  const add = signal.s.addEventListener;
  console.log(add === target.addEventListener, signal.s.dispatchEvent === target.dispatchEvent);
  console.log(add.name, add.length, "addEventListener" in signal.s, "throwIfAborted" in target);
  const heard = (event) => console.log("heard", event.type, event.target === target);
  add.call(target, "ping", heard);
  console.log(signal.s.dispatchEvent.call(target, new Event("ping")));
  signal.s.removeEventListener.call(target, "ping", heard);
  target.dispatchEvent(new Event("ping"));
  try {
    throwIfAborted.call(target);
  } catch (e) {
    report("target throwIfAborted", e);
  }
}

async function streams() {
  const box = { body: untyped(new Response("stream").body) };
  const key = "getReader";
  const reader = box.body[key]();
  const read = reader.read;
  const first = await read.call(reader);
  console.log(first.done, new TextDecoder().decode(first.value));
  await read().catch((e) => report("unbound read", e));
  try {
    box.body.getReader.call(reader);
  } catch (e) {
    report("foreign getReader", e);
  }
}

(async () => {
  await bodies();
  shape();
  await receivers();
  await streams();
})();
