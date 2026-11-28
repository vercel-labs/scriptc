// A request header key that carries a NUL byte is not a header name Node
// accepts: the client request throws ERR_INVALID_HTTP_TOKEN. A record built at
// run time must not turn such a key into a different (valid) header.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

const server = http.createServer((req, res) => {
  const seen: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name === "Host" || name === "Connection") continue;
    seen.push(name + "=" + req.rawHeaders[i + 1]!);
  }
  console.log("server", seen.join("|"));
  res.end("ok");
});

function report(label: string, error: unknown): void {
  const caught = error as NodeJS.ErrnoException;
  console.log(label, caught.code, caught.message);
}

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  const injected: Record<string, string> = {};
  injected["\u0000x-injected"] = "1";
  injected["x-ok"] = "ok";
  try {
    const request = http.request(
      { port, host: "127.0.0.1", headers: injected },
      (res) => {
        res.resume();
        res.on("end", () => server.close());
      },
    );
    request.on("error", (error) => console.log("request error", (error as NodeJS.ErrnoException).code));
    request.end();
    console.log("accepted");
  } catch (error) {
    report("nul key", error);
    server.close();
  }
});
