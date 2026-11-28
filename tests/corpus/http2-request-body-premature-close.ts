// An HTTP/2 compatibility request body iterated with for-await: when the
// session goes away mid-body the iterator rejects with Node's
// ERR_STREAM_PREMATURE_CLOSE ("Premature close"), and the request the bridge
// holds is released. A watchdog reports a still-pending iterator.
import { createServer, connect } from "node:http2";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 500);

const server = createServer((req, res) => {
  void (async () => {
    try {
      let bytes = 0;
      for await (const chunk of req) bytes += chunk.length;
      console.log(`end ${bytes}`);
    } catch (error) {
      const err = error as Error & { code?: string };
      console.log(`error ${err.code} ${err.message}`);
    }
    try {
      res.end();
    } catch {
      // the session is gone
    }
    clearTimeout(watchdog);
    client.destroy();
    server.close();
  })();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const address = server.address();
if (address === null || typeof address === "string") throw new Error("server has no port");
const client = connect(`http://127.0.0.1:${address.port}`);
client.on("error", () => {});
const stream = client.request({ ":method": "POST", ":path": "/" });
stream.on("error", () => {});
stream.write(Buffer.alloc(10));
setTimeout(() => client.destroy(), 30);
