// @requires-libnode
// What island code writes on a program error is written on the program's
// error, and what the program writes the island reads: a logger that marks
// the error, a library that sets `code` and `message`, a catch block that
// adds a status and rethrows, a field of a class instance, and a delete.
import { tag, write, remove, readKept, keysKept, keep, rethrowTagged, logger } from "err-view";

class HttpError extends Error {
  constructor(m, status) {
    super(m);
    this.name = "HttpError";
    this.status = status;
    this.code = undefined;
  }
}

// A property the island adds, and two it overwrites.
const plain = new Error("plain");
tag(plain);
console.log("tagged:", plain.message, plain.code, plain.handled, "handled" in plain, String(plain));

// An island logger that counts how often it saw the error.
const log = logger();
const reported = new Error("out of range");
log.error(reported);
log.error(reported);
console.log("logged:", reported.logged, log.lines());

// A catch block in the island that adds to the error and rethrows it.
const thrown = new Error("thrown");
try {
  rethrowTagged(() => {
    throw thrown;
  });
} catch (e) {
  console.log("rethrown:", e === thrown, thrown.status, thrown.retried, thrown.message);
}

// A class instance: the island writes its fields and its message and name.
const http = new HttpError("gone", 410);
keep("http", http);
console.log("field:", write(http, "status", 500), http.status);
console.log("empty field:", write(http, "code", "E_GONE"), http.code);
console.log("message:", write(http, "message", "rewritten"), http.message, String(http));
console.log("name:", write(http, "name", "Renamed"), http.name, String(http));

// The program's writes, read by the island without the error crossing again.
http.status = 501;
http.message = "changed natively";
console.log("native writes:", readKept("http", "status"), readKept("http", "message"), keysKept("http"));

// A property the island deletes.
const other = new Error("other");
other.extra = 7;
keep("other", other);
console.log("before delete:", readKept("other", "extra"), keysKept("other"));
console.log("delete:", remove(other, "extra"), other.extra, "extra" in other, keysKept("other"));
