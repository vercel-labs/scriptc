import { Agent, Pool, fetch, request } from "undici";

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
