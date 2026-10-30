// socket.pipe(destination) after socket.setEncoding(enc) writes the
// decoded strings to the destination, as Node's pipe writes each string
// chunk: the destination receives their UTF-8 bytes, a split character
// arrives whole, and a partial character held at EOF is written before the
// destination ends.
"use strict";
const net = require("net");

const source = net.createServer((socket) => {
  socket.on("error", () => {});
  socket.write(Buffer.from([0x61, 0xc3]));
  setTimeout(() => socket.end(Buffer.from([0xa9, 0x62, 0xe2, 0x82])), 50);
});

const received = new Map();
const collector = net.createServer((socket) => {
  const chunks = [];
  let label = null;
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("end", () => {
    const all = Buffer.concat(chunks);
    const newline = all.indexOf(0x0a);
    label = all.subarray(0, newline).toString();
    received.set(label, all.subarray(newline + 1).toString("hex"));
    if (received.size === encodings.length) {
      for (const name of encodings) console.log(name, received.get(name));
      source.close();
      collector.close();
    }
  });
});

const encodings = ["utf8", "hex", "base64", "latin1", "ucs2"];
source.listen(0, "127.0.0.1", () => {
  collector.listen(0, "127.0.0.1", () => {
    for (const encoding of encodings) {
      const destination = net.connect(collector.address().port, "127.0.0.1");
      destination.write(encoding + "\n");
      const client = net.connect(source.address().port, "127.0.0.1");
      client.setEncoding(encoding);
      client.pipe(destination);
    }
  });
});
