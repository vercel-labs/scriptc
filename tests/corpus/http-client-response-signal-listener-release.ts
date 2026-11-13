// The client-side twin: a response's 'abort' listener captures the response
// it never fires for (the body completes), and the response settles at
// 'close' after 'end'. The settled message drops the signal's listeners so
// the response→signal→listener→response cycle does not outlive the
// exchange; LeakSanitizer pins that (tests/harness/http-message-signal-
// leaks.test.ts), and the output here is the same either way.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((_request, response) => {
  response.end("body");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const request = http.get({ host: "127.0.0.1", port, agent: false }, (response) => {
    const signal = response.signal;
    signal.addEventListener("abort", () => console.log("unexpected abort", response.statusCode));
    console.log("same signal", signal === response.signal, signal.aborted);
    let body = "";
    response.on("data", (chunk: Uint8Array) => {
      body += Buffer.from(chunk).toString();
    });
    response.on("end", () => {
      console.log("end", body, signal.aborted);
    });
    response.on("close", () => {
      console.log("close", response.complete, signal.aborted);
      server.close(() => console.log("closed"));
    });
  });
  request.on("error", (error) => console.log("client error", error.message));
});
