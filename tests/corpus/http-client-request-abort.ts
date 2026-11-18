// request.abort(): the aborted flag it sets at once, the second call's
// no-op, and the event order the abort produces — 'close' then 'abort'
// before a socket is assigned, and 'abort', the socket-hang-up error and
// 'close' when the request had already reached the wire.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  setTimeout(() => {
    if (!res.writableEnded) res.end("late");
  }, 30);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;

  const report = (req: http.ClientRequest, label: string): void => {
    console.log(label, "aborted", req.aborted, "destroyed", req.destroyed, "finished", req.finished);
  };

  const events: string[] = [];
  const early = http.request({ host: "127.0.0.1", port, path: "/early", agent: false }, () => {
    events.push("response");
  });
  early.on("abort", () => events.push("abort"));
  early.on("close", () => events.push("close"));
  early.on("error", (err) => events.push("error " + (err as NodeJS.ErrnoException).code));
  early.on("socket", () => events.push("socket"));
  report(early, "early before");
  early.abort();
  report(early, "early after abort");
  early.abort();
  report(early, "early after second");

  setTimeout(() => {
    console.log("early events", events.join(","));
    const wired: string[] = [];
    const inFlight = http.request({ host: "127.0.0.1", port, path: "/wired", agent: false }, () => {
      wired.push("response");
    });
    inFlight.on("socket", () => {
      wired.push("socket");
      inFlight.abort();
      report(inFlight, "wired after abort");
    });
    inFlight.on("abort", () => wired.push("abort"));
    inFlight.on("error", (err) =>
      wired.push("error " + (err as NodeJS.ErrnoException).code + " " + err.message),
    );
    inFlight.on("close", () => {
      wired.push("close");
      report(inFlight, "wired close");
      console.log("wired events", wired.join(","));
      server.close(() => console.log("closed"));
    });
    inFlight.end();
  }, 100);
});
