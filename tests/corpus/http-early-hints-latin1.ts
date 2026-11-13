// An informational head's obs-text goes out as one Latin-1 byte. The header
// validator accepts U+0080..U+00FF, and the wire form of U+008D is the single
// byte 0x8D — not 0x0D, which would end the field line early. A raw client
// captures the 103 block and prints it as hex, so the bytes are the output.
import * as http from "node:http";
import * as net from "node:net";

const server = http.createServer((_request, response) => {
  response.writeEarlyHints({ link: "</a.css>; rel=preload; title=a\u008Dbÿc" });
  response.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const client = net.connect(port, "127.0.0.1", () => {
    client.write("GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n");
  });
  let raw = Buffer.alloc(0);
  client.on("data", (chunk: Buffer) => {
    raw = Buffer.concat([raw, chunk]);
  });
  client.on("close", () => {
    const end = raw.indexOf("\r\n\r\n");
    console.log(JSON.stringify(raw.subarray(0, end).toString("latin1")));
    console.log(raw.subarray(0, end).toString("hex"));
    server.close();
  });
});
