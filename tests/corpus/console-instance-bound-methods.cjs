// Node's Console constructor binds each output method to its instance, so a
// method stored off the instance keeps writing to that instance's target
// (`const { log } = consoleInstance`). The bound function has the method's
// name and arity, identity holds across reads, and dynamic calls format
// their arguments with util.format, %s/%d included.
const { Console } = require("node:console");
const { Writable } = require("node:stream");

const lines = [];
const target = new Writable({
  write(chunk, encoding, callback) {
    lines.push(String(chunk));
    callback();
  },
});

const out = new Console({ stdout: target, stderr: target });
const log = out.log;
const error = out.error;
console.log("bound", typeof log, log.name, log.length);
log("log", 1, "two", { a: 1 });
error("error %s", "formatted");
out.info("direct %d", 42);
console.log("identity", out.log === out.log, out.log === log, out.error === error);
console.log("written", JSON.stringify(lines));
