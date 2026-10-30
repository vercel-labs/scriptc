// socket.setEncoding takes any Buffer encoding name in any ASCII case and
// decodes 'data' with a StringDecoder: a character split across two
// chunks arrives whole, a chunk that completes no character emits no
// 'data', and a partial character held at the end is the last 'data'.
// An unknown name throws ERR_UNKNOWN_ENCODING.
import * as net from "node:net";

const server = net.createServer((socket) => {
  socket.on("error", () => {});
  // "a", then the two bytes of "é" split across writes, then "b" and the
  // first two bytes of "€", which never complete.
  socket.write(Buffer.from([0x61, 0xc3]));
  setTimeout(() => socket.end(Buffer.from([0xa9, 0x62, 0xe2, 0x82])), 50);
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as net.AddressInfo;
  const encodings = ["UTF8", "Utf-8", "latin1", "BINARY", "hex", "base64", "ascii", "ucs2", "UTF16LE"];
  let left = encodings.length;
  const results = new Map<string, string>();
  for (const encoding of encodings) {
    const chunks: string[] = [];
    const client = net.connect(port, "127.0.0.1");
    client.setEncoding(encoding as BufferEncoding);
    client.on("data", (chunk: string) => chunks.push(`${typeof chunk}:${JSON.stringify(chunk)}`));
    client.on("end", () => {
      results.set(encoding, chunks.join(" | "));
      if (--left === 0) {
        for (const name of encodings) console.log(name, results.get(name));
        server.close();
      }
    });
  }
  const probe = net.connect(port, "127.0.0.1");
  probe.on("error", () => {});
  for (const name of ["nope", "utf-16", ""]) {
    try {
      probe.setEncoding(name as BufferEncoding);
      console.log(JSON.stringify(name), "accepted");
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      console.log(JSON.stringify(name), e.name, e.code, e.message);
    }
  }
  probe.destroy();
});
