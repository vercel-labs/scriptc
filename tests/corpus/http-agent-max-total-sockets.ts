// agent.maxTotalSockets: Node's cap across every name — a request that would
// push the agent past it waits until a socket frees, with the option, the
// getter and the setter all reaching the same accounting.
import * as http from "node:http";

const one = http.createServer((req, res) => {
  console.log("one request");
  setTimeout(() => {
    console.log("one respond");
    res.end("a");
  }, 20);
});

const two = http.createServer((req, res) => {
  console.log("two request");
  res.end("b");
});

one.listen(0, "127.0.0.1", () => {
  two.listen(0, "127.0.0.1", () => {
    const agent = new http.Agent({ keepAlive: false, maxSockets: 10, maxTotalSockets: 1 });
    console.log("maxTotalSockets", agent.maxTotalSockets, agent.maxSockets);
    agent.maxTotalSockets = 2;
    console.log("set", agent.maxTotalSockets);
    agent.maxTotalSockets = 1;

    const a = http.request(
      { host: "127.0.0.1", port: (one.address() as { port: number }).port, path: "/", agent },
      (res) => {
        res.resume();
        res.on("end", () => console.log("first done", res.statusCode));
      },
    );
    a.end();

    const b = http.request(
      { host: "127.0.0.1", port: (two.address() as { port: number }).port, path: "/", agent },
      (res) => {
        res.resume();
        res.on("end", () => {
          console.log("second done", res.statusCode);
          agent.destroy();
          one.close();
          two.close();
        });
      },
    );
    b.end();
  });
});
