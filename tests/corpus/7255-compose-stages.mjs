// stream.compose in JavaScript with an iterable or generator first stage
// (the Duplex is not writable), a stage that throws (the Duplex errors),
// a destroyed composition (the stages see an AbortError), and compose()
// with no stages (ERR_MISSING_ARGS).
import { PassThrough, compose } from "node:stream";

const log = [];

const double = async function* (source) {
  for await (const n of source) yield n * 2;
};

const fromArray = compose([1, 2, 3], double);
log.push(`array r=${fromArray.readable} w=${fromArray.writable}`);
for await (const n of fromArray) log.push(`array ${n}`);

function* counter() {
  yield 10;
  yield 20;
}
const fromGen = compose(counter(), double, async function* (source) {
  for await (const n of source) yield `n=${n}`;
});
for await (const s of fromGen) log.push(`gen ${s}`);

const failing = compose(new PassThrough({ objectMode: true }), async function* (source) {
  for await (const chunk of source) {
    if (chunk === "stop") throw new Error("stage failed on " + chunk);
    yield chunk;
  }
}, new PassThrough({ objectMode: true }));
failing.on("data", (c) => log.push(`failing data ${c}`));
failing.on("error", (e) => log.push(`failing error ${e.message}`));
failing.on("close", () => log.push(`failing close ${failing.destroyed}`));
failing.write("go");
failing.write("stop");
await new Promise((resolve) => failing.on("close", resolve));

const stopped = compose(new PassThrough({ objectMode: true }), double);
stopped.on("error", (e) => log.push(`stopped error ${e.name} ${e.code}`));
stopped.on("close", () => log.push("stopped close"));
stopped.write(4);
stopped.once("data", (n) => {
  log.push(`stopped data ${n}`);
  stopped.destroy();
});
await new Promise((resolve) => stopped.on("close", resolve));

try {
  compose();
} catch (e) {
  log.push(`empty ${e.code} ${e.message}`);
}

console.log(log.join("\n"));
