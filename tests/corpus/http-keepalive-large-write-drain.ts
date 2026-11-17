// Repeated keep-alive exchanges whose body is a single write at or above the
// response's 64 KiB high-water mark: each write arms the socket-drain bridge,
// and the exchange settles with the bridge off the socket's list, so the next
// exchange starts from a clean socket. The output is the same whether or not
// the bridge is unregistered; the point is that the arm/disarm path runs four
// times over one pooled socket, and the sanitized lane compiles and runs this
// program with AddressSanitizer and the reference-count audit on.
import * as http from "node:http";
import * as net from "node:net";

const body = Buffer.alloc(160 * 1024, 0x61);

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Length": String(body.length) });
  response.write(body);
  response.end();
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  let left = 4;
  const next = (): void => {
    http.get({ host: "127.0.0.1", port, agent }, (response) => {
      let received = 0;
      response.on("data", (chunk: Uint8Array) => {
        received += chunk.length;
      });
      response.on("end", () => {
        console.log("exchange", received, response.statusCode);
        left -= 1;
        if (left > 0) {
          next();
          return;
        }
        agent.destroy();
        server.close(() => console.log("closed"));
      });
    });
  };
  next();
});
