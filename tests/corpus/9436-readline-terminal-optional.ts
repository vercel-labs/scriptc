// createInterface with a `terminal` option whose value may be undefined:
// an undefined value is an absent option (the output's isTTY when there is
// an output, otherwise not a terminal), a boolean is taken as it is.
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

function open(label: string, terminal: boolean | undefined): void {
  const input = new PassThrough();
  const rl = createInterface({ input, terminal });
  console.log(label, rl.terminal);
  rl.on("line", (line) => console.log(label, "line", line));
  rl.on("close", () => console.log(label, "closed"));
  input.end("only\n");
}
open("undefined", undefined);
open("false", false);

const flag: boolean | undefined = process.argv.length > 99 ? true : undefined;
const viaOutput = createInterface({
  input: new PassThrough(),
  output: process.stdout,
  terminal: flag,
});
console.log("stdout default", viaOutput.terminal === Boolean(process.stdout.isTTY));
viaOutput.close();

const off: boolean | undefined = process.argv.length > 99 ? undefined : false;
const forced = createInterface({ input: new PassThrough(), output: process.stdout, terminal: off });
console.log("explicit false", forced.terminal);
forced.close();

const literal = createInterface({ input: new PassThrough(), terminal: undefined });
console.log("literal undefined", literal.terminal);
literal.close();
