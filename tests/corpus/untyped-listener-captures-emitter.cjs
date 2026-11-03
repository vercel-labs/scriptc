// A listener attached through an untyped value (a JavaScript parameter
// with no type) that captures the emitter it listens on: the emitter holds
// the listener, the listener holds the emitter. React's pipe() registers
// handlers like this on its destination. A stream keeps its listeners after
// it finishes, so only the collector can free the pair, and it has to see
// through the listener to do so; the sanitized lane's RC audit fails on a
// leaked stream.
const { Writable } = require("node:stream");

const events = [];

function pipeInto(destination, label) {
  destination.on("finish", () => events.push(`${label} finish ${destination.writableFinished}`));
  destination.on("close", () => events.push(`${label} close ${destination.destroyed}`));
  destination.write(`<${label}>`);
  destination.end(`</${label}>`);
}

function render(label) {
  return new Promise((resolve) => {
    let written = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        written += chunk;
        callback();
      },
    });
    destination.on("finish", () => resolve(written));
    pipeInto(destination, label);
  });
}

(async () => {
  console.log(await render("w"));
  await new Promise((resolve) => setImmediate(resolve));
  for (const event of events) console.log(event);
})();
