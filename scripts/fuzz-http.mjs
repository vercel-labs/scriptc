// The Node side of the socket-level fuzz targets (tests/fuzz/README.md): a raw client that sends damaged HTTP/1
// requests to the compiled server, and a raw server that answers the compiled client with damaged responses.
//
// A case is [mode, salt, bytes], with the bytes as a Latin-1 string. Every generated case depends only on
// (seed, index), and how a case is cut into writes and timed depends only on its salt, so a failure is replayed
// from the case file alone.
import { readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A small xorshift generator; the same (a, b) always gives the same sequence. */
export function generator(a, b) {
  let s = ((a ^ 0x9e3779b9) + Math.imul(b + 1, 0x85ebca6b)) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  for (let i = 0; i < 4; i++) next();
  return (n) => (n <= 0 ? 0 : next() % n);
}

const requestDictionary = [
  "\r\n",
  "\n",
  "\r",
  " ",
  "\t",
  ":",
  ";",
  ",",
  "Content-Length: ",
  "Transfer-Encoding: chunked\r\n",
  "Transfer-Encoding: ",
  "chunked",
  "Connection: close\r\n",
  "Connection: keep-alive\r\n",
  "Host: ",
  "Expect: 100-continue\r\n",
  "Upgrade: h2c\r\n",
  "HTTP/1.1",
  "HTTP/1.0",
  "HTTP/0.9",
  "HTTP/2.0",
  "0\r\n\r\n",
  "ffffffffffffffff\r\n",
  "-1",
  "18446744073709551616",
  "0x10",
  "+5",
  " 5 ",
  "\0",
  "\x7f",
  "\xff",
  "\xc3\xa9",
  "%00",
  "GET ",
  "POST ",
  "M-SEARCH ",
  "QUERY ",
  "Trailer: X\r\n",
  "TE: trailers\r\n",
  "Content-Encoding: gzip\r\n",
  "Keep-Alive: timeout=5\r\n",
  "Proxy-Connection: keep-alive\r\n",
  "3\r\nabc\r\n",
  "GET /z HTTP/1.1\r\nHost: a\r\n\r\n",
  "X: " + "a".repeat(300) + "\r\n",
];
const responseDictionary = [
  "\r\n",
  "\n",
  "\r",
  " ",
  ":",
  "Content-Length: ",
  "Transfer-Encoding: chunked\r\n",
  "Content-Encoding: gzip\r\n",
  "Content-Encoding: br, gzip, deflate, zstd\r\n",
  "Location: ",
  "http://",
  "//",
  "\\",
  "0\r\n\r\n",
  "ffffffffffffffff\r\n",
  "-1",
  "999999999999999999999",
  "HTTP/1.1 ",
  "HTTP/9.9 ",
  "200",
  "099",
  "1000",
  "\0",
  "\xff",
  "\xc3\xa9",
  "Set-Cookie: ",
  "Connection: keep-alive\r\n",
  "Keep-Alive: timeout=1, max=",
  "X: " + "b".repeat(500) + "\r\n",
];

function mutate(ri, text, dictionary, seeds, rounds) {
  let x = Buffer.from(text, "latin1");
  for (let r = rounds; r > 0; r--) {
    const at = ri(x.length + 1);
    const op = ri(8);
    if (op === 0) {
      const piece = Buffer.from(dictionary[ri(dictionary.length)], "latin1");
      x = Buffer.concat([x.subarray(0, at), piece, x.subarray(at)]);
    } else if (op === 1) x = Buffer.concat([x.subarray(0, at), x.subarray(at + ri(12) + 1)]);
    else if (op === 2) {
      x = Buffer.concat([x.subarray(0, at), x.subarray(at, at + ri(40) + 1), x.subarray(at)]);
    } else if (op === 3) {
      if (x.length > 0) {
        x = Buffer.from(x);
        x[ri(x.length)] = ri(256);
      }
    } else if (op === 4) {
      x = Buffer.concat([x, Buffer.from(seeds[ri(seeds.length)][2], "latin1")]);
    } else if (op === 5) x = x.subarray(0, at);
    else if (op === 6) {
      const piece = Buffer.from(dictionary[ri(dictionary.length)], "latin1");
      x = Buffer.concat([x.subarray(0, at), ...Array(ri(200) + 2).fill(piece), x.subarray(at)]);
    } else {
      x = Buffer.concat([x.subarray(0, at), Buffer.alloc(ri(70000), 0x61 + ri(3)), x.subarray(at)]);
    }
  }
  return x.toString("latin1");
}

/** The request case of (seed, index): a seed request with one to five edits. */
export function requestCase(seed, index, seeds) {
  const ri = generator(seed, index);
  const text = mutate(ri, seeds[ri(seeds.length)][2], requestDictionary, seeds, ri(5) + 1);
  return [String(ri(4)), String(ri(0x7fffffff)), text];
}

/** The response case of (seed, index): a seed response with up to four edits. */
export function responseCase(seed, index, seeds) {
  const ri = generator(seed, index);
  const text = mutate(ri, seeds[ri(seeds.length)][2], responseDictionary, seeds, ri(5));
  return [String(ri(3) === 0 ? 1 : 0), String(ri(0x7fffffff)), text];
}

/**
 * Send one request case on a new connection and resolve with the client's port and everything the server
 * answered. Mode 0 sends the bytes in one write; the other modes cut them at places the salt chooses, a few
 * milliseconds apart. With `linger` the connection is dropped that many milliseconds after the last write, which
 * is what the server fuzzer wants; otherwise it stays open until the server closes it or has been silent for
 * `idle` milliseconds.
 */
export function sendRequest(port, [mode, salt, text], { idle = 400, linger } = {}) {
  return new Promise((resolve) => {
    const ri = generator(Number(salt), 0);
    const payload = Buffer.from(text, "latin1");
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let localPort = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ localPort, answer: Buffer.concat(chunks).toString("latin1") });
    };
    let timer = setTimeout(finish, idle);
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("data", (data) => {
      chunks.push(data);
      if (linger !== undefined) return;
      clearTimeout(timer);
      timer = setTimeout(finish, idle);
    });
    socket.on("connect", () => {
      localPort = socket.localPort;
      let sent = 0;
      const step = () => {
        if (done) return;
        if (sent >= payload.length) {
          if (linger !== undefined) setTimeout(finish, linger);
          return;
        }
        const n = mode === "0" ? payload.length : ri(Math.max(1, payload.length >> 1)) + 1;
        socket.write(payload.subarray(sent, sent + n));
        sent += n;
        setTimeout(step, ri(3));
      };
      step();
    });
  });
}

/** Whether the server still answers a well-formed request. */
export function alive(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000);
    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.on("data", (data) => {
      answer += data.toString("latin1");
      if (!answer.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer.startsWith("HTTP/1.1 200"));
    });
    socket.on("connect", () =>
      socket.write("GET /probe HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n"),
    );
  });
}

/**
 * A server that answers request /g<i> or /f<i> with `caseOf(i)`, and anything else (a followed redirect) with a
 * plain 200. The salt chooses where the response is split and how long the second part waits; mode 0 then ends
 * the connection and mode 1 resets it 30 ms later. `last()` is the highest index asked for so far.
 */
export function responseServer(caseOf) {
  let last = -1;
  const open = new Set();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const match = /^[A-Z]+ \/[gf](\d+) /.exec(data.toString("latin1"));
      if (match === null) {
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        return;
      }
      const index = Number(match[1]);
      if (index > last) last = index;
      const [mode, salt, text] = caseOf(index);
      const ri = generator(Number(salt), 0);
      const payload = Buffer.from(text, "latin1");
      const half = ri(payload.length + 1);
      socket.write(payload.subarray(0, half));
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(payload.subarray(half));
        if (mode === "0") socket.end();
        else setTimeout(() => socket.destroy(), 30);
      }, ri(3));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        last: () => last,
        close: () =>
          new Promise((closed) => {
            for (const socket of open) socket.destroy();
            server.close(closed);
          }),
      }),
    );
  });
}

// node scripts/fuzz-http.mjs serve <case file>: answer every request with that one response case, to replay a
// client failure by hand with `http-client <port> <index> 1`.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] !== "serve" || process.argv[3] === undefined) {
    console.error("usage: node scripts/fuzz-http.mjs serve <case file>");
    process.exit(2);
  }
  const served = JSON.parse(readFileSync(process.argv[3], "utf8"));
  responseServer(() => served).then((server) => console.log(`listening ${server.port}`));
}
