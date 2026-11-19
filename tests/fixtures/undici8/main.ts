import { Agent, Dispatcher, Pool, fetch, request } from "undici";

const origin = process.argv[2]!;
const agent = new Agent({
  allowH2: false,
  factory(origin, options) {
    console.log("factory", (options as { allowH2?: boolean }).allowH2);
    return new Pool(origin, { allowH2: false });
  },
});
let poolFactoryOption = "unused";
const pool = new Pool(origin, {
  allowH2: false,
  connections: 1,
  factory(url, options) {
    poolFactoryOption = String((options as { allowH2?: boolean }).allowH2);
    return new Pool(url, { allowH2: false });
  },
});
try {
  const get = await request(origin + "/read?q=1");
  console.log(get.statusCode, get.headers["x-route"], await get.body.text());
  const post = await request(origin + "/write", {
    dispatcher: agent,
    method: "POST",
    body: "payload",
  });
  console.log(post.statusCode, await post.body.text());
  const rawOptions = { method: "GET" as const, responseHeaders: "raw" as const };
  const raw = await request(origin + "/raw", rawOptions);
  console.log("raw", Array.isArray(raw.headers) && raw.headers.slice(0, 4).join("|"));
  await raw.body.dump();
  const empty = await request(origin + "/empty");
  await empty.body.dump();
  console.log("dumped", JSON.stringify(await empty.body.text()));
  class FailingDispatcher extends Dispatcher {
    dispatch(_opts: Parameters<Dispatcher["dispatch"]>[0], handler: Parameters<Dispatcher["dispatch"]>[1]): boolean {
      handler.onResponseError!(null!, new Error("custom dispatcher"));
      return false;
    }
  }
  const custom = new Agent({ allowH2: false, factory: () => new FailingDispatcher() });
  try {
    await request(origin, { dispatcher: custom });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.log("handler", err.message);
  }
  const failure = new FailingDispatcher();
  try {
    await failure.request({ path: "/", method: "GET" });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.log("instance", err.message);
  }
  class LocalDispatcher extends Dispatcher {
    dispatch(_opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const controller = { rawHeaders: null, paused: false, aborted: false, reason: null,
        pause() {}, resume() {}, abort(_reason: Error) {} };
      handler.onRequestStart!(controller, { route: "chosen" });
      handler.onResponseStart!(controller, 103, { "x-source": "hint" }, "Early Hints");
      handler.onResponseStart!(controller, 200, { "x-source": "parsed" }, "OK");
      handler.onResponseEnd!(controller, {});
      return true;
    }
  }
  const local = new LocalDispatcher();
  const parsed = await request(origin, { dispatcher: local, onInfo({ headers }) {
    console.log("hint", headers["x-source"]);
  } });
  console.log("custom", parsed.headers["x-source"], JSON.stringify(parsed.context));
  await parsed.body.dump();
  const localRaw = await local.request({ path: "/", method: "GET", responseHeaders: "raw",
    onInfo({ headers }) { console.log("raw hint", JSON.stringify(headers)); } });
  console.log("custom raw", JSON.stringify(localRaw.headers), agent instanceof Dispatcher);
  await localRaw.body.dump();
  const missing = await fetch(origin + "/missing", { dispatcher: pool });
  console.log(missing.status, await missing.text());
  console.log("pool factory", poolFactoryOption);
  const options = { method: "GET" as const, query: { page: 2, tag: ["a b", "c/d"] } };
  const items = await request(origin + "/items", options);
  console.log(await items.body.text());
  try {
    await request(origin + "/items?old=1", options);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.log(err.message);
  }
  const redirected = await fetch(origin + "/redirect#local", { dispatcher: pool });
  const copy = redirected.clone();
  console.log(redirected.url === origin + "/final", redirected.redirected, await redirected.text());
  console.log("clone", copy.url === redirected.url, copy.redirected, await copy.text());
  const manual = await fetch(origin + "/redirect#local", { dispatcher: pool, redirect: "manual" });
  console.log(manual.url === origin + "/redirect", manual.redirected, manual.status);
  await manual.text();
  for (const path of ["/stream", "/empty"]) {
    const { body } = await request(origin + path);
    await new Promise<void>((resolve) => {
      body.once("end", () => resolve());
      body.resume();
    });
    console.log(path, body.bodyUsed);
    try {
      console.log("remaining", await body.text());
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      console.log(err.name, err.message);
    }
  }
  try {
    await request(origin, { method: "CONNECT" });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    console.log(err.name, err.message);
  }
} finally {
  await agent.close();
  await pool.close();
}
