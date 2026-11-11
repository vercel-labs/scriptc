// The web -> node adapters: Writable.fromWeb (decodeStrings and objectMode,
// the web sink's close awaiting the finish event) and Duplex.fromWeb over a
// TransformStream pair, its allowHalfOpen option, and an aborted signal.
import { Duplex, Writable } from "node:stream";

const log: string[] = [];

function pair(): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      controller.enqueue(chunk);
    },
  });
}

async function main(): Promise<void> {
  const seen: string[] = [];
  const w = Writable.fromWeb(
    new WritableStream<Uint8Array>({
      write(chunk): void {
        seen.push(`${typeof chunk} ${String(chunk)}`);
      },
      close(): void {
        log.push("web closed");
      },
    }),
  );
  w.write("a");
  w.write("b");
  w.end("c");
  await new Promise<void>((resolve) => w.on("finish", () => resolve()));
  log.push(`seen ${seen.join(",")}`);
  log.push(`hwm ${w.writableHighWaterMark} objectMode ${String(w.writableObjectMode)}`);

  const raw: string[] = [];
  const noDecode = Writable.fromWeb(
    new WritableStream<string>({
      write(chunk): void {
        raw.push(`${typeof chunk} ${String(chunk)}`);
      },
    }),
    { decodeStrings: false },
  );
  noDecode.end("plain");
  await new Promise<void>((resolve) => noDecode.on("finish", () => resolve()));
  log.push(`raw ${raw.join(",")}`);

  const ts = pair();
  const d = Duplex.fromWeb({ readable: ts.readable, writable: ts.writable });
  const got: string[] = [];
  d.on("data", (chunk: unknown) => got.push(String(chunk)));
  d.write("round");
  await new Promise<void>((resolve) => d.on("end", () => resolve()));
  log.push(`duplex ${got.join(",")}`);

  const ts2 = pair();
  const d2 = Duplex.fromWeb({ readable: ts2.readable, writable: ts2.writable }, { allowHalfOpen: true });
  d2.end();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  log.push(`half open ${String(d2.writableEnded)} ${String(d2.readableEnded)}`);

  const ac = new AbortController();
  const ts3 = pair();
  const d3 = Duplex.fromWeb({ readable: ts3.readable, writable: ts3.writable }, { signal: ac.signal });
  d3.on("error", (e: Error) => log.push(`abort ${e.name}`));
  d3.on("close", () => log.push("abort close"));
  ac.abort();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  for (const line of log) console.log(line);
}

void main();
