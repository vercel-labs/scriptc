// The generic validation codes Node's own argument checks raise, as a
// program meets them: the class the error belongs to, its `code`, and its
// message, for the checks the runtime performs itself. Written as a
// JavaScript module because the wrong-typed arguments these checks reject
// are what a TypeScript source refuses to pass in the first place.
import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import util from "node:util";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";

const tmp = path.join(os.tmpdir(), "scriptc-error-validation-codes.txt");
fs.writeFileSync(tmp, "text");

/** One line per check: the builtin class, the code, and Node's message. */
function report(label, fn) {
  try {
    fn();
    console.log(label, "ok");
  } catch (error) {
    const kind =
      error instanceof RangeError
        ? "RangeError"
        : error instanceof TypeError
          ? "TypeError"
          : error instanceof Error
            ? "Error"
            : typeof error;
    console.log(label, kind, error.code, JSON.stringify(error.message));
  }
}

// ERR_INVALID_ARG_TYPE: a value of the wrong type.
report("fs.path.null", () => fs.readFileSync(null));
report("fs.data.number", () => fs.writeFileSync(tmp, 5));
report("path.join.number", () => path.join(1));
report("stream.from.number", () => Readable.from(5));
// ERR_INVALID_ARG_VALUE: a value of the right type the API rejects.
report("fs.encoding", () => fs.readFileSync(tmp, "bogus"));
// ERR_ARG_NOT_ITERABLE: a value with no Symbol.iterator where one is
// required.
report("readablestream.from.number", () => ReadableStream.from(5));
// ERR_OUT_OF_RANGE: a number outside what the API accepts.
report("buffer.alloc.negative", () => Buffer.alloc(-1));
report("buffer.write.negative", () => Buffer.alloc(4).write("x", -1));
report("buffer.readUInt8.past-end", () => Buffer.alloc(2).readUInt8(9));
// ERR_BUFFER_OUT_OF_BOUNDS: a view past the end of its ArrayBuffer.
report("buffer.from.bad-offset", () => Buffer.from(new ArrayBuffer(4), 10));
report("buffer.from.bad-length", () => Buffer.from(new ArrayBuffer(4), 0, 10));
// ERR_UNKNOWN_ENCODING and ERR_ENCODING_NOT_SUPPORTED: an encoding name
// belongs to Buffer's table, a decoder label to the Web Encoding table.
report("buffer.from.encoding", () => Buffer.from("x", "bogus"));
report("textdecoder.label", () => new TextDecoder("bogus"));
// ERR_UNKNOWN_SIGNAL and ERR_SOCKET_BAD_PORT.
report("process.kill.signal", () => process.kill(process.pid, "NOPE"));
report("net.port", () => net.connect(99999, "127.0.0.1").on("error", () => {}));
// ERR_MISSING_ARGS: no argument can stand for the required one.
report("net.connect.none", () => net.connect().destroy());
// ERR_INVALID_URL, ERR_INVALID_PROTOCOL and the HTTP header checks.
report("http.url", () => http.get("nope"));
report("http.protocol", () => http.request("ftp://example.com/x"));
report("http.path-space", () =>
  http.request({ host: "127.0.0.1", path: "/a b" }).on("error", () => {}),
);
report("http.header-name", () => http.request({ headers: { "bad name": "v" } }));
report("http.header-value", () => http.request({ headers: { "x-test": "a\nb" } }));
report("http.setHeader-name", () => {
  const request = http.request("http://127.0.0.1/").on("error", () => {});
  request.setHeader("bad name", "v");
  request.destroy();
});
report("http.setHeader-value", () => {
  const request = http.request("http://127.0.0.1/").on("error", () => {});
  request.setHeader("x-test", "a\nb");
  request.destroy();
});
// ERR_INVALID_TUPLE: a query pair that is not a [name, value] tuple.
report("urlsearchparams.tuple", () => new URLSearchParams([["a"]]));
// The file-URL checks: the scheme, the host and the encoded separators.
report("fileurl.scheme", () => url.fileURLToPath("http://x/y"));
report("fileurl.host", () => url.fileURLToPath("file://example.com/x"));
report("fileurl.path", () => url.fileURLToPath("file:///a%2Fb"));
// ERR_INCOMPATIBLE_OPTION_PAIR: two spellings of the same option.
report("scrypt.options", () => crypto.scryptSync("a", "b", 32, { N: 2, cost: 1 }));
// A bare assertion lowered before any string-message assertion must not
// decide the message form's catch body: each form runs its own check.
report("assert.throws.bare-early", () => {
  assert.throws(() => {
    throw new Error("dup");
  });
});
// ERR_AMBIGUOUS_ARGUMENT: assert.throws whose matcher message is also
// the message of the error the callback throws.
report("assert.throws.ambiguous", () => {
  assert.throws(() => {
    throw new Error("dup");
  }, "dup");
});
report("assert.throws.ambiguous-string", () => {
  assert.throws(() => {
    throw "dup";
  }, "dup");
});
// A matcher message that differs from the thrown message stays the
// message: the call passes.
report("assert.throws.message-only", () => {
  assert.throws(() => {
    throw new Error("other");
  }, "dup");
});
// The message is an ordinary property read: an inherited one counts, a
// getter runs, and a getter that throws propagates its own error.
function Thrown() {}
Thrown.prototype.message = "dup";
report("assert.throws.inherited", () => {
  assert.throws(() => {
    throw new Thrown();
  }, "dup");
});
report("assert.throws.getter", () => {
  assert.throws(() => {
    throw {
      get message() {
        return "dup";
      },
    };
  }, "dup");
});
report("assert.throws.getter-throws", () => {
  assert.throws(() => {
    throw {
      get message() {
        throw new Error("exploded");
      },
    };
  }, "dup");
});
// The message is read a second time for the diagnostic's quoted text, as
// lib/assert.js interpolates it: a stateful getter is quoted by its second
// answer, and a getter that throws on the second read propagates that error.
const stateful = {
  reads: 0,
  get message() {
    return this.reads++ === 0 ? "dup" : "changed";
  },
};
report("assert.throws.stateful-getter", () => {
  assert.throws(() => {
    throw stateful;
  }, "dup");
});
console.log("assert.throws.stateful-reads", stateful.reads);
const secondReadThrows = {
  reads: 0,
  get message() {
    if (this.reads++ === 0) return "dup";
    throw new Error("second read");
  },
};
report("assert.throws.second-read-throws", () => {
  assert.throws(() => {
    throw secondReadThrows;
  }, "dup");
});
// A bare assertion and a string-message assertion of the same callback type
// are different checks: the bare one must not hide the ambiguous one.
const shared = () => {
  throw new Error("dup");
};
report("assert.throws.bare-first", () => {
  assert.throws(shared);
});
report("assert.throws.message-after-bare", () => {
  assert.throws(shared, "dup");
});
// The same check guards a rejection whose reason carries the matcher
// message (assert.rejects shares expectsError).
try {
  await assert.rejects(async () => {
    throw new Error("dup");
  }, "dup");
  console.log("assert.rejects.ambiguous ok");
} catch (error) {
  console.log("assert.rejects.ambiguous", error.name, error.code, JSON.stringify(error.message));
}
// ERR_PARSE_ARGS_UNKNOWN_OPTION and ERR_INVALID_MIME_SYNTAX.
report("parseargs.unknown", () => util.parseArgs({ args: ["--nope"], options: {} }));
report("mimetype.syntax", () => new util.MIMEType("bad"));
// ERR_UNHANDLED_ERROR: an 'error' event emitted with a non-Error value.
report("emitter.unhandled", () => {
  new EventEmitter().emit("error", "oops");
});

// ERR_SERVER_ALREADY_LISTEN: a second listen() before close().
const server = net.createServer();
server.listen(0);
report("net.listen.twice", () => server.listen(0));
server.close();
// ERR_SERVER_NOT_RUNNING: close() reports through the callback.
net.createServer().close((error) => {
  console.log("net.close.not-running", error.code, JSON.stringify(error.message));
});
