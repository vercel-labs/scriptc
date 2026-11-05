// pipeline() with a function stage that has overload signatures: the
// signatures have no body, so the stage is still one function declaration
// that nothing reassigns, and the pipeline lowers it like any other stage.
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";

function shout(source: AsyncIterable<string>): AsyncGenerator<string>;
function shout(source: AsyncIterable<unknown>): AsyncGenerator<string>;
async function* shout(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const chunk of source) yield `${String(chunk).toUpperCase()}!`;
}

async function main(): Promise<void> {
  const seen: string[] = [];
  await pipeline(
    Readable.from(["a", "b", "c"]),
    shout,
    new Writable({
      objectMode: true,
      write(chunk: unknown, _encoding, callback) {
        seen.push(String(chunk));
        callback();
      },
    }),
  );
  console.log(seen.join(" "));
}

void main();
