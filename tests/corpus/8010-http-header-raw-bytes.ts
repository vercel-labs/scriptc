// Header values hold the raw bytes a client sent, one character per byte
// (Node decodes them as latin1). Bytes that are not well-formed UTF-8 (lone
// continuation bytes, runs of them, truncated leads, overlong leads and
// bytes no sequence uses) at every offset within an eight-byte word encode
// to the same bytes as in Node with latin1, ascii, binary, hex, base64 and
// utf16le. Strings built in the program take the same encodings with two-,
// three- and four-byte characters at every offset.
import { createServer } from "node:http";
import { connect } from "node:net";

const patterns: number[][] = [
  [0x80],
  [0x80, 0x81, 0xbf, 0x90],
  [0xc3],
  [0xc0, 0x80, 0xc1, 0xbf],
  [0xe9, 0x41, 0xe9],
  [0xf0, 0x9f, 0x41],
  [0xe2, 0x82],
  [0xff, 0xfe, 0xf5],
  [0x78, 0xe9, 0x79, 0x80, 0x80, 0x7a, 0xdf],
];
const encodings = ["latin1", "ascii", "binary", "hex", "base64", "utf16le"] as const;

function hex(bytes: Buffer): string {
  return bytes.toString("hex");
}

function describe(label: string, value: string): void {
  console.log(label, encodings.map((encoding) => `${encoding}=${hex(Buffer.from(value, encoding))}`).join(" "));
}

const names: string[] = [];
const head: Buffer[] = [Buffer.from("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n")];
for (let p = 0; p < patterns.length; p++) {
  for (let offset = 0; offset < 10; offset++) {
    for (const tail of ["", "bcdefghij"]) {
      const name = `x-${p}-${offset}-${tail.length}`;
      names.push(name);
      head.push(Buffer.from(`${name}: ${"a".repeat(offset)}`));
      head.push(Buffer.from(patterns[p]!));
      head.push(Buffer.from(`${tail}\r\n`));
    }
  }
}
head.push(Buffer.from("\r\n"));

const server = createServer((req, res) => {
  for (const name of names) {
    const value = req.headers[name];
    if (typeof value === "string") describe(name, value);
    else console.log(name, "missing");
  }
  res.end("ok");
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const socket = connect({ port, host: "127.0.0.1" }, () => {
    socket.write(Buffer.concat(head));
  });
  socket.on("data", () => {});
  socket.on("close", () => {
    server.close();
    for (const text of ["é", "éü", "ß€", "😀", "é😀ü", "߿\u0080"]) {
      for (let offset = 0; offset < 17; offset++) {
        const value = "a".repeat(offset) + text + "b".repeat(offset % 9) + text;
        describe(`text ${offset} ${JSON.stringify(text)}`, value);
      }
    }
  });
});
