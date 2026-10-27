// createInterface over an input or output that is a function's result,
// an object's member or an array element.
import * as readline from "node:readline";
import * as readlinePromises from "node:readline/promises";
import { PassThrough, Readable, Writable } from "node:stream";

function source(lines) {
  return Readable.from([lines.join("\n") + "\n"]);
}
const streams = { input: source(["a", "b"]), output: new PassThrough() };
streams.output.on("data", (d) => console.log("out", JSON.stringify(String(d))));

const rl1 = readline.createInterface({ input: source(["one", "two"]) });
for await (const line of rl1) console.log("rl1", line);

const rl2 = readline.createInterface({ input: streams.input, output: streams.output, prompt: "? " });
rl2.prompt();
for await (const line of rl2) console.log("rl2", line);

const inputs = [source(["x"]), source(["y"])];
for (const [i, input] of inputs.entries()) {
  const rl = readline.createInterface(input);
  rl.on("line", (line) => console.log("rl3", i, line));
  await new Promise((resolve) => {
    rl.on("close", () => resolve(undefined));
  });
}

const sink = new Writable({
  write(chunk, _encoding, callback) {
    console.log("sink", JSON.stringify(String(chunk)));
    callback();
  },
});
const make = () => ({ input: new PassThrough(), output: sink });
const opts = make();
const prl = readlinePromises.createInterface(opts.input, opts.output);
const answer = prl.question("name? ");
opts.input.write("ada\n");
console.log("answer", await answer);
prl.close();
