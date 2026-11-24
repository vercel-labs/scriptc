// A request that queued for an agent slot and ended before it started is
// handed its socket later: the 'socket' event comes first, then 'finish', as
// Node orders them, so a 'finish' listener added inside the 'socket' callback
// still runs.
import * as http from "node:http";

const server = http.createServer((req, res) => {
  setTimeout(() => res.end("ok"), 60);
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  http.globalAgent.maxSockets = 1;
  const events = [];
  let done = 0;
  const finish = () => {
    done += 1;
    if (done === 2) {
      console.log(events.join("|"));
      server.close();
    }
  };
  const a = http.request({ host: "127.0.0.1", port, path: "/a" }, (res) => {
    res.resume();
    res.on("end", finish);
  });
  a.on("socket", () => events.push("socket a"));
  a.on("finish", () => events.push("finish a"));
  a.end();
  const b = http.request({ host: "127.0.0.1", port, path: "/b" }, (res) => {
    res.resume();
    res.on("end", finish);
  });
  b.on("socket", () => {
    events.push("socket b");
    b.on("finish", () => events.push("finish b"));
  });
  b.end();
});
