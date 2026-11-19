// OutgoingMessage.pipe(): an outgoing message is write-only, so Node emits
// ERR_STREAM_CANNOT_PIPE after evaluating the call's arguments. A request
// hands the error to its 'error' listeners; with none registered the emit is
// the throw at the call, which a try statement catches either way. A response
// takes no 'error' listener here, so it always throws at the call.
import * as http from "node:http";

const mark = (what: string): { write: () => boolean } => {
  console.log("arg", what);
  return { write: () => true };
};

const boom = (): { write: () => boolean } => {
  throw new Error("boom");
};

const server = http.createServer((req, res) => {
  try {
    res.pipe();
    console.log("res pipe accepted");
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.log("res pipe", e.code, e.message);
  }
  // Stream.pipe's destination is accepted and ignored, but its expression is
  // evaluated first: Node's override answers the same error afterwards.
  try {
    res.pipe(mark("dest"));
    console.log("res pipe destination accepted");
  } catch (err) {
    console.log("res pipe destination", (err as { code?: string }).code);
  }
  // An argument that throws is the throw; the pipe error never fires.
  try {
    res.pipe(boom());
    console.log("res pipe boom accepted");
  } catch (err) {
    console.log("res pipe boom", (err as Error).message);
  }
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const withListener = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
    res.on("data", () => {});
    res.on("end", () => {
      console.log("response", res.statusCode);
      withoutListener();
    });
  });
  withListener.on("error", (err) => {
    console.log("req pipe", (err as { code?: string }).code, err.message);
  });
  withListener.pipe(mark("client-dest"));
  withListener.end();

  const withoutListener = (): void => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        console.log("second response", res.statusCode);
        server.close();
      });
    });
    try {
      req.pipe(mark("no-listener"));
      console.log("unexpected");
    } catch (err) {
      console.log("caught", (err as { code?: string }).code, (err as Error).message);
    }
    req.end();
  };
});
