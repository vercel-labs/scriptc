// 'line' listeners that change while a line is delivered: a listener added
// by the only line listener starts with the next line, after which both
// run in order; a once listener next to a persistent one runs for one line;
// and no listener sees a line twice.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const text = "a\nb\nc\nd\ne\nf\n";

const first = createInterface({ input: Readable.from([text]) });
let seen = 0;
const counting = (line: string): void => {
  seen++;
  console.log("counting", line);
  if (seen === 2) first.on("line", (later: string) => console.log("later", later));
};
first.on("line", counting);
first.on("close", () => {
  console.log("first closed", seen);

  const second = createInterface({ input: Readable.from([text]) });
  second.once("line", (line: string) => console.log("once", line));
  second.on("line", (line: string) => console.log("every", line));
  second.on("close", () => {
    console.log("second closed");

    const third = createInterface({ input: Readable.from(["x\ny\n", "z\n"]) });
    const seenLines: string[] = [];
    third.on("line", (line: string) => seenLines.push(line));
    third.on("close", () => console.log("third", seenLines.join(",")));
  });
});
