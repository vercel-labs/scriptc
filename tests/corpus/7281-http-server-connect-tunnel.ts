// An HTTP CONNECT proxy on node:http: the server's 'connect' listener gets
// the request, the raw client socket and the bytes read past the request
// head, opens a TCP connection to the requested host and pipes both ways.
// 'once' and 'addListener' register the same event, and 'upgrade' hands
// over the socket for an Upgrade request.
import * as http from "node:http";
import * as net from "node:net";

const target = net.createServer((socket) => {
  socket.on("data", (d) => socket.write(`echo:${d.toString()}`));
});

const proxy = http.createServer((_req, res) => res.end("plain"));
const seen: string[] = [];
proxy.on("connect", (req, clientSocket, head) => {
  seen.push(`connect ${req.method} ${req.url} head=${head.length}`);
  const [host, port] = (req.url ?? "").split(":");
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
});
proxy.once("connect", (req) => seen.push(`once ${req.url}`));
proxy.addListener("upgrade", (req, socket, head) => {
  seen.push(`upgrade ${req.headers.upgrade} head=${head.length}`);
  socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
});

function tunnel(
  proxyPort: number,
  targetPort: number,
  payload: string,
  withHead: boolean,
): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(proxyPort, "127.0.0.1", () => {
      const request = `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`;
      c.write(withHead ? request + payload : request);
    });
    let text = "";
    let sent = withHead;
    c.on("data", (d) => {
      text += d.toString();
      if (!sent && text.includes("\r\n\r\n")) {
        sent = true;
        c.write(payload);
      }
      if (sent && text.includes(`echo:${payload}`)) {
        c.end();
        resolve(text);
      }
    });
  });
}

function upgrade(proxyPort: number): Promise<string> {
  return new Promise((resolve) => {
    const u = net.connect(proxyPort, "127.0.0.1", () => {
      u.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n");
    });
    let text = "";
    u.on("data", (d) => (text += d.toString()));
    u.on("end", () => resolve(text.split("\r\n")[0] ?? ""));
  });
}

target.listen(0, "127.0.0.1", () => {
  const targetPort = (target.address() as net.AddressInfo).port;
  proxy.listen(0, "127.0.0.1", async () => {
    const proxyPort = (proxy.address() as net.AddressInfo).port;
    console.log(JSON.stringify(await tunnel(proxyPort, targetPort, "first", false)));
    console.log(JSON.stringify(await tunnel(proxyPort, targetPort, "second", false)));
    console.log(JSON.stringify(await tunnel(proxyPort, targetPort, "with-head", true)));
    console.log(JSON.stringify(await upgrade(proxyPort)));
    console.log(seen.join("\n").replaceAll(String(targetPort), "PORT"));
    proxy.close();
    target.close();
  });
});
