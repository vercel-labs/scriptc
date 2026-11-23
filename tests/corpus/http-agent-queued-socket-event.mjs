// A request that queues for an agent slot gets its 'socket' event when the
// agent assigns the socket (when the request starts), not when the request
// is created: the first request's event and response come first, then the
// queued request's event, then its response.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  setTimeout(() => res.end(req.url), 50);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  http.globalAgent.maxSockets = 1;
  const events = [];
  let done = 0;
  const go = (tag) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/" + tag }, (res) => {
      res.resume();
      res.on("end", () => {
        events.push("end " + tag);
        done += 1;
        if (done === 2) {
          console.log(events.join("|"));
          server.close();
        }
      });
    });
    req.on("socket", () => events.push("socket " + tag));
    req.on("error", (e) => events.push("error " + tag + " " + e.code));
    req.end();
  };
  go("a");
  go("b");
});
