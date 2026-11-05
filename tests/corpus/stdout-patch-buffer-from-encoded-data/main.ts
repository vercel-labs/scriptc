// A Buffer written to a replaced process.stdout.write from a 'data' listener
// of a socket or an HTTP response with setEncoding("utf8") arrives as a
// Buffer; the listener's own chunks are strings. patch.mjs installs the
// replacement and prints what it received at exit.
import * as http from "node:http";
import * as net from "node:net";
import "./patch.mjs";

const tcp = net.createServer((socket) => socket.end("tcp-data"));
tcp.listen(0, "127.0.0.1", () => {
  const port = (tcp.address() as net.AddressInfo).port;
  const client = net.connect(port, "127.0.0.1");
  client.setEncoding("utf8");
  client.on("data", (text: string) => {
    process.stdout.write(Buffer.from(`socket ${typeof text} ${text}`));
    process.stdout.write(`socket text ${text}`);
  });
  client.on("end", () => {
    tcp.close();
    const server = http.createServer((req, res) => res.end("http-data"));
    server.listen(0, "127.0.0.1", () => {
      const httpPort = (server.address() as net.AddressInfo).port;
      http.get(`http://127.0.0.1:${httpPort}/`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (text: string) => {
          process.stdout.write(Buffer.from(`response ${typeof text} ${text}`));
        });
        res.on("end", () => server.close());
      });
    });
  });
});
