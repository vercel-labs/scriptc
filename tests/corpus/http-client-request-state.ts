// The ClientRequest surface: the state properties before the send, after the
// body is written, and once the exchange settles, plus the request-side
// events ('socket', 'response', 'finish', 'close') and the interim
// 'continue' and 'information' reports a 100-continue request receives in
// order.
import * as http from "node:http";

function report(req: http.ClientRequest, label: string): void {
  console.log(
    label,
    req.method,
    req.path,
    req.host,
    req.protocol,
    req.aborted,
    req.destroyed,
    req.finished,
    req.writableEnded,
    req.writableFinished,
    req.reusedSocket,
    req.headersSent,
  );
}

const server = http.createServer((req, res) => {
  if (req.url === "/continue") {
    res.writeContinue();
    res.writeEarlyHints({ link: "</style.css>; rel=preload; as=style" });
    res.end("continued");
    return;
  }
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const events: string[] = [];
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/continue",
      method: "POST",
      headers: { expect: "100-continue" },
    },
    (res) => {
      events.push("response");
      console.log("response", res.statusCode);
      res.resume();
      res.on("end", () => {
        console.log("events", events.join(","));
        report(req, "after");
        req.on("close", () => {
          console.log("request close");
          server.close(() => console.log("closed"));
        });
      });
    },
  );
  report(req, "before");
  req.on("socket", () => events.push("socket"));
  req.on("continue", () => events.push("continue"));
  req.on("information", (info) => events.push("information " + info.statusCode));
  req.on("finish", () => events.push("finish"));
  req.on("response", () => events.push("response-event"));
  req.on("abort", () => events.push("abort"));
  req.end("body");
});
