// An object literal that wraps a stream fills a narrow writer type: the
// wrapper's write forwards to process.stdout, or to a Writable instance
// whose chunks and finish event arrive in order.
import { Writable } from "node:stream";

interface LineSink {
  write(line: string): boolean;
  close(): void;
}

function writeLines(out: LineSink, lines: string[]): void {
  for (const line of lines) out.write(`${line}\n`);
  out.close();
}

const toStdout: LineSink = {
  write: (line: string): boolean => process.stdout.write(line),
  close: (): void => {
    process.stdout.write("stdout wrapper closed\n");
  },
};
writeLines(toStdout, ["one", "two"]);

const received: string[] = [];
const target = new Writable({
  write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    received.push(chunk.toString().trim());
    callback();
  },
});
target.on("finish", () => {
  console.log(`finished with ${received.join(", ")}`);
});
const toWritable: LineSink = {
  write: (line: string): boolean => target.write(line),
  close: (): void => {
    target.end();
  },
};
writeLines(toWritable, ["alpha", "beta", "gamma"]);
