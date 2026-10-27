// question() with a query that is not a string: a non-terminal interface
// throws (callback form) or rejects (readline/promises) with Node's
// ERR_INVALID_ARG_TYPE from the output write, and the question stays
// pending; a terminal interface writes the query as a string.
const readline = require("readline");
const readlinePromises = require("readline/promises");
const { PassThrough } = require("stream");

function capture(name) {
  const output = new PassThrough();
  output.on("data", (d) => console.log(name, JSON.stringify(String(d))));
  return output;
}

async function main() {
  const input = new PassThrough();
  const rl = readline.createInterface({ input, output: capture("out") });
  rl.on("line", (line) => console.log("line", line));
  try {
    rl.question(42, (answer) => console.log("answer", answer));
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
  try {
    rl.prompt();
  } catch (e) {
    console.log("prompt", e.code, e.message);
  }
  input.write("first\nsecond\n");
  await new Promise((resolve) => setImmediate(resolve));
  console.log("prompt after", JSON.stringify(rl.getPrompt()));
  rl.close();

  for (const query of [undefined, null, { a: 1 }, [1, 2], true]) {
    const prl = readlinePromises.createInterface({ input: new PassThrough() });
    try {
      await prl.question(query);
    } catch (e) {
      console.log("rejected", e.code, e.message);
    }
    prl.close();
  }

  const tin = new PassThrough();
  const trl = readline.createInterface({ input: tin, output: capture("tty"), terminal: true });
  trl.question(7, (answer) => console.log("tty answer", answer));
  tin.write("x\r");
  await new Promise((resolve) => setImmediate(resolve));
  trl.close();
}
main();
