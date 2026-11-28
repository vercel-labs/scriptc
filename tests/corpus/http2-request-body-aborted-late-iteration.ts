// Iterating an HTTP/2 compatibility request only after its session went
// away: the compat stream's readable completed at the teardown, so Node's
// iterator ends without error even though the request is aborted and the
// bytes it held are gone. The iteration starts from the request's own
// 'close' event, after the abort state is in place.
import { createServer, connect } from "node:http2";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 1000);

const server = createServer((req, res) => {
  req.once("close", () => {
    console.log(`server close aborted ${req.aborted} complete ${req.complete}`);
    void (async () => {
      try {
        const lengths: number[] = [];
        for await (const chunk of req) lengths.push(chunk.length);
        console.log(`server end ${JSON.stringify(lengths)}`);
      } catch (error) {
        const err = error as Error & { code?: string };
        console.log(`server error ${JSON.stringify(err.message)} ${err.code}`);
      }
      try {
        res.end();
      } catch {
        // the session is gone
      }
      clearTimeout(watchdog);
      server.close();
    })();
  });
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
setTimeout(() => client.destroy(), 40);

await new Promise<void>((resolve) => setTimeout(resolve, 400));
console.log("done");
