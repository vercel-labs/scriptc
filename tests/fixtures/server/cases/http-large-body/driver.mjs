// Raw keep-alive client that reads slowly (pause/resume per chunk) so the
// server's large writes complete partially and drain through its buffer.
// Prints each response's status line, headers except Date, framing, body
// length, and body digest (segment and chunk boundaries are not compared).
import { createHash } from "node:crypto";
import { connect } from "node:net";

const port = Number(process.argv[2]);

function parse(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd < 0) return null;
  const lines = buf.subarray(0, headEnd).toString("latin1").split("\r\n");
  const headers = lines.slice(1).map((line) => {
    const colon = line.indexOf(":");
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  });
  const find = (name) => headers.find(([k]) => k.toLowerCase() === name)?.[1];
  let at = headEnd + 4;
  const length = find("content-length");
  if (length !== undefined) {
    const end = at + Number(length);
    if (buf.length < end) return null;
    return { lines, headers, framing: "content-length", body: buf.subarray(at, end), rest: buf.subarray(end) };
  }
  if (find("transfer-encoding") === "chunked") {
    const pieces = [];
    for (;;) {
      const eol = buf.indexOf("\r\n", at);
      if (eol < 0) return null;
      const size = parseInt(buf.subarray(at, eol).toString("latin1"), 16);
      if (Number.isNaN(size)) throw new Error("bad chunk size");
      if (size === 0) {
        if (buf.length < eol + 4) return null;
        if (buf.subarray(eol + 2, eol + 4).toString("latin1") !== "\r\n") throw new Error("bad terminator");
        return { lines, headers, framing: "chunked", body: Buffer.concat(pieces), rest: buf.subarray(eol + 4) };
      }
      if (buf.length < eol + 2 + size + 2) return null;
      pieces.push(buf.subarray(eol + 2, eol + 2 + size));
      if (buf.subarray(eol + 2 + size, eol + 4 + size).toString("latin1") !== "\r\n") throw new Error("bad chunk end");
      at = eol + 4 + size;
    }
  }
  throw new Error("no framing");
}

function exchange(socket, path) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      socket.pause();
      setTimeout(() => socket.resume(), 1);
      let parsed;
      try {
        parsed = parse(buf);
      } catch (error) {
        reject(error);
        return;
      }
      if (!parsed) return;
      socket.off("data", onData);
      const shown = parsed.headers.filter(([k]) => k.toLowerCase() !== "date").map(([k, v]) => `${k}: ${v}`);
      console.log(`${path} -> ${parsed.lines[0]} | ${shown.join(" | ")}`);
      const digest = createHash("sha256").update(parsed.body).digest("hex").slice(0, 16);
      console.log(`  ${parsed.framing} length=${parsed.body.length} sha256=${digest} extra=${parsed.rest.length}`);
      resolve();
    };
    socket.on("data", onData);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  });
}

const socket = connect(port, "127.0.0.1");
await new Promise((resolve) => socket.once("connect", resolve));
for (const path of ["/end", "/small", "/write", "/end", "/quit"]) await exchange(socket, path);
socket.end();
console.log("driver done");
