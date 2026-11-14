// request.destroy() on a request in flight: the destroyed flag it sets
// inside the call, the socket-hang-up error the teardown reports, and the
// 'close' that follows; destroy(undefined) takes the same path, destroy(err)
// reports that error instead, and a destroy once the response completed only
// flips the flag.
import * as http from "node:http";

const server = http.createServer((_req, res) => {
  setTimeout(() => {
    if (!res.writableEnded) res.end("late");
  }, 30);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;

  const inFlight = (label: string, destroy: (req: http.ClientRequest) => void) =>
    new Promise<void>((resolve) => {
      const events: string[] = [];
      const req = http.request({ host: "127.0.0.1", port, path: "/" + label, agent: false }, () => {
        events.push("response");
      });
      req.on("socket", () => events.push("socket"));
      req.on("error", (err) =>
        events.push("error " + (err as NodeJS.ErrnoException).code + " " + err.message),
      );
      req.on("close", () => {
        events.push("close");
        console.log(label, "events", events.join(","), "aborted", req.aborted, "destroyed", req.destroyed);
        resolve();
      });
      req.end();
      setTimeout(() => {
        destroy(req);
        console.log(label, "inside destroy", req.destroyed, req.aborted, req.finished);
      }, 10);
    });

  void (async () => {
    await inFlight("plain", (req) => req.destroy());
    await inFlight("undefined", (req) => req.destroy(undefined));
    await inFlight("error", (req) => req.destroy(new Error("boom")));

    const late = http.request({ host: "127.0.0.1", port, path: "/late", agent: false }, (res) => {
      res.resume();
      res.on("end", () => {
        console.log("late at end", late.destroyed, late.writableFinished);
        late.on("close", () => {
          console.log("late close", late.destroyed);
          server.close(() => console.log("closed"));
        });
        late.destroy();
        console.log("late after destroy", late.destroyed);
      });
    });
    late.on("error", (err) => console.log("late error", (err as NodeJS.ErrnoException).code));
    late.end();
  })();
});
