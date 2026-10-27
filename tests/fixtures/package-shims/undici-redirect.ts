// Follows and rejects redirects whose bodies never end
// (undici-hostile-peer.mjs, port in argv[2]) through a pool of one
// connection. The discarded redirect's request is aborted, so its
// connection closes, the follow-up request gets a connection, and the peer
// reports the redirect's connection closed.
import { Agent, fetch } from "undici";

const origin = `http://127.0.0.1:${process.argv[2]}`;
const dispatcher = new Agent({ connections: 1 });
const followed = await fetch(`${origin}/redirect-endless`, { dispatcher });
console.log("follow", followed.status, await followed.text());
try {
  await fetch(`${origin}/redirect-endless`, { dispatcher, redirect: "error" });
} catch (err) {
  console.log("error mode", (err as Error).name, (err as Error).message);
}
const after = await fetch(`${origin}/redirect-closed`, { dispatcher });
console.log("after error mode", await after.text());
await dispatcher.close();
