import { Agent, Pool, fetch, request } from "undici";

const origin = process.argv[2]!;
const agent = new Agent({ allowH2: false });
const pool = new Pool(origin, { allowH2: false });
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
