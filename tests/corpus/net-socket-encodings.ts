// socket.write(data, encoding) and socket.end(data, encoding): the string
// is encoded like Buffer.from's (utf8, latin1, utf16le, base64, base64url,
// hex, ascii), a Buffer chunk ignores the encoding, and an unknown name
// throws Node's ERR_UNKNOWN_ENCODING at the call. The server echoes what it
// receives, so the program prints the bytes that crossed for each form.
import * as net from "node:net";

const out: string[] = [];
const say = (...parts: unknown[]): void => {
  out.push(parts.map((part) => String(part)).join(" "));
};
const codeOf = (err: unknown): string => String((err as { code?: string }).code);

const cases: readonly [string, string, BufferEncoding, string][] = [
  ["utf8", "café", "utf8", "636166c3a9"],
  ["latin1", "café", "latin1", "636166e9"],
  ["utf16le", "hi", "utf16le", "68006900"],
  ["base64", "aGk=", "base64", "6869"],
  ["base64url", "aGk", "base64url", "6869"],
  ["hex", "6869", "hex", "6869"],
  ["ascii", "hi", "ascii", "6869"],
];

let server: net.Server;
let client: net.Socket;
let index = 0;
let ending = false;

const done = (): void => {
  client.destroy();
  server.close(() => {
    say("closed");
    console.log(out.join("\n"));
  });
};

const next = (): void => {
  if (index < cases.length) {
    const [label, payload, encoding, expected] = cases[index]!;
    say(label, "expected", expected);
    client.write(payload, encoding);
    return;
  }
  if (!ending) {
    ending = true;
    say("end-expected", "656e64");
    client.end("656e64", "hex");
  }
};

server = net.createServer((socket) => {
  socket.on("data", (chunk: Buffer) => socket.write(chunk));
  socket.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => {
  // the encoding ladder's errors are synchronous and catchable
  const scratch = new net.Socket();
  try {
    scratch.write("x", "nope" as BufferEncoding);
    say("unknown-encoding", "accepted");
  } catch (err) {
    say("unknown-encoding", codeOf(err), JSON.stringify((err as Error).message));
  }
  try {
    scratch.write(Buffer.from("hi"), "nope" as BufferEncoding);
    say("buffer-unknown-encoding", "accepted");
  } catch (err) {
    say("buffer-unknown-encoding", codeOf(err), JSON.stringify((err as Error).message));
  }
  // the string ladder has no "buffer" encoding; a Buffer chunk accepts the
  // exact spelling and still ignores it, and the name is case-sensitive there
  try {
    scratch.write("x", "buffer" as BufferEncoding);
    say("string-buffer-encoding", "accepted");
  } catch (err) {
    say("string-buffer-encoding", codeOf(err), JSON.stringify((err as Error).message));
  }
  say("buffer-chunk-buffer-encoding", scratch.write(Buffer.from("hi"), "buffer" as BufferEncoding));
  try {
    scratch.write(Buffer.from("hi"), "Buffer" as BufferEncoding);
    say("buffer-chunk-buffer-case", "accepted");
  } catch (err) {
    say("buffer-chunk-buffer-case", codeOf(err), JSON.stringify((err as Error).message));
  }
  // a literal utf8 spelling writes the string's own UTF-8 bytes
  say("utf8-literal-write", scratch.write("hi", "utf8"));
  // a valid encoding beside a Buffer chunk is validated, then ignored
  say("buffer-valid-encoding", scratch.write(Buffer.from("hi"), "base64"));
  try {
    scratch.end(Buffer.from("hi"), "nope" as BufferEncoding);
    say("end-buffer-unknown-encoding", "accepted");
  } catch (err) {
    say("end-buffer-unknown-encoding", codeOf(err), JSON.stringify((err as Error).message));
  }
  scratch.destroy();

  const port = (server.address() as { port: number }).port;
  client = net.connect(port, "127.0.0.1");
  client.setEncoding("hex");
  client.on("connect", next);
  client.on("data", (hex: string) => {
    if (index < cases.length) {
      const [label, , , expected] = cases[index]!;
      say(label, "received", hex, hex === expected);
      index += 1;
      next();
      return;
    }
    if (ending) {
      say("end-received", hex, hex === "656e64");
      done();
    }
  });
  client.on("error", (err) => {
    say("client-error", codeOf(err));
    done();
  });
});
