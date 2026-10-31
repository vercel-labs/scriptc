// Line splitting over stream chunks: an unfinished line joined across many
// chunks, a line longer than a chunk, empty lines, LF-only
// chunks next to chunks with CR and CRLF, an ASCII chunk after a chunk that
// ends inside a UTF-8 sequence, and text written with rl.write(). Each line
// event shows the line's length and its first and last characters.
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

function show(tag: string, line: string): void {
  console.log(tag, line.length, JSON.stringify(line.slice(0, 12)), JSON.stringify(line.slice(-6)));
}

function feed(tag: string, chunks: (string | Buffer)[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const src = new Readable({ read() {} });
    const rl = createInterface({ input: src, crlfDelay: Infinity });
    rl.on("line", (line: string) => show(tag, line));
    rl.on("close", () => {
      console.log(tag, "closed");
      resolve();
    });
    for (const chunk of chunks) src.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    src.push(null);
  });
}

const long = "x".repeat(70000) + "y";
await feed("joined", ["par", "tial ", "line", " continues", "\nnext\n", "tail"]);
await feed("long", [long.slice(0, 30000), long.slice(30000, 65536), long.slice(65536) + "\nshort\n"]);
await feed("empty", ["\n\n", "a\n\n", "\n", "b"]);
await feed("mixed", ["lf only\nstill lf\n", "cr\rcrlf\r\nlf\n", "end\r", "\nafter\r", "\r\n", "done"]);
const euro = Buffer.from("€uro\n", "utf8");
await feed("utf8", [euro.subarray(0, 2), Buffer.concat([euro.subarray(2), Buffer.from("plain ascii\nmore")])]);
await feed("utf8-lines", ["café one\nnaïve two\n", "ascii three\n", "中文 four"]);

const writer = createInterface({ input: new Readable({ read() {} }), crlfDelay: Infinity });
writer.on("line", (line: string) => show("write", line));
writer.write("first part ");
writer.write("second part\nthird\r\nfourth\rfifth");
writer.write("\n");
writer.close();
