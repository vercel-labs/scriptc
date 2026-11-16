// A shared keep-alive agent with a finite maxTotalSockets: when a pooled
// socket closes, the capacity it held must start the next queued request.
import * as http from "node:http";
import * as net from "node:net";

const a = net.createServer((socket) => {
  socket.on("data", () => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
    setTimeout(() => socket.destroy(), 60);
  });
  socket.on("error", () => {});
});

const b = net.createServer((socket) => {
  socket.on("data", () => {
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
  });
  socket.on("error", () => {});
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });

const close = (): void => {
  agent.destroy();
  a.close();
  b.close();
};

a.listen(0, "127.0.0.1", () => {
  b.listen(0, "127.0.0.1", () => {
    const portA = (a.address() as { port: number }).port;
    const portB = (b.address() as { port: number }).port;
    http.get({ host: "127.0.0.1", port: portA, path: "/", agent }, (res) => {
      res.resume();
      res.on("end", () => {
        console.log("A done");
        const guard = setTimeout(() => {
          console.log("B never started");
          close();
        }, 2000);
        http.get({ host: "127.0.0.1", port: portB, path: "/", agent }, (res2) => {
          res2.resume();
          res2.on("end", () => {
            console.log("B done");
            clearTimeout(guard);
            close();
          });
        }).on("error", (e) => console.log("B error", e.message));
      });
    }).on("error", (e) => console.log("A error", e.message));
  });
});
