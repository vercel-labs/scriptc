// An HTTP/2 compatibility request iterated with for-await when the session
// goes away while the loop body is busy: the iterator is not parked at that
// moment, so the destroy error must be held for its next read and rejected
// there (ERR_STREAM_PREMATURE_CLOSE), never raised as an unhandled 'error'.
// The session is destroyed from inside the loop body's own window.
import { createServer, connect } from "node:http2";

const watchdog = setTimeout(() => {
  console.log("pending");
  process.exit(2);
}, 1000);

const server = createServer((req, res) => {
  void (async () => {
    try {
      let bytes = 0;
      for await (const chunk of req) {
        console.log(`server chunk ${chunk.length}`);
        setTimeout(() => req.stream.session.destroy(), 20);
        await new Promise((resolve) => setTimeout(resolve, 60));
        bytes += chunk.length;
      }
      console.log(`server end ${bytes}`);
    } catch (error) {
      const err = error as Error & { code?: string };
      console.log(`server error ${JSON.stringify(err.message)} ${err.code}`);
    }
    console.log(`server after aborted ${req.aborted} complete ${req.complete}`);
    try {
      res.end();
    } catch {
      // the session is gone
    }
    clearTimeout(watchdog);
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

await new Promise<void>((resolve) => setTimeout(resolve, 400));
console.log("done");
