// Repeated keep-alive uploads whose body is a single corked write at or above
// the client message's 64 KiB high-water mark: the write answers false and arms
// the socket-drain bridge on the socket the pool hands to the next exchange,
// and the exchange settles with the bridge off the socket's list. The output is
// the same whether or not the bridge is unregistered; the point is that the
// arm/flush/disarm path runs four times over one pooled socket, and the
// sanitized lane compiles and runs this program with AddressSanitizer and the
// reference-count audit on.
import * as http from "node:http";
import * as net from "node:net";

const body = Buffer.alloc(160 * 1024, 0x61);

const server = http.createServer((request, response) => {
  let received = 0;
  request.on("data", (chunk: Uint8Array) => {
    received += chunk.length;
  });
  request.on("end", () => {
    response.writeHead(200, { "Content-Length": String(String(received).length) });
    response.end(String(received));
  });
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  let left = 4;
  const next = (): void => {
    const request = http.request(
      { host: "127.0.0.1", port, method: "POST", agent },
      (response) => {
        let text = "";
        response.on("data", (chunk: Uint8Array) => {
          text += Buffer.from(chunk).toString();
        });
        response.on("end", () => {
          console.log("exchange", response.statusCode, text);
          left -= 1;
          if (left > 0) {
            next();
            return;
          }
          agent.destroy();
          server.close(() => console.log("closed"));
        });
      },
    );
    // The write waits for the connection, so the bridge arms on the pooled
    // socket rather than on this request's dial handle.
    setTimeout(() => {
      request.cork();
      request.write(body);
      request.uncork();
      request.end();
    }, 1);
  };
  next();
});
