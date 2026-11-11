// Readable.from(iterable[, options]): the encoding and signal options
// (from.js spreads them into the Readable constructor, which installs the
// decoder with setEncoding and then addAbortSignal).
import { Readable } from "node:stream";

function show(c: string | Buffer): string {
  return typeof c === "string" ? `s:${c}` : `b:${String(c)}`;
}

function collect(label: string, r: Readable): Promise<void> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    r.on("data", (c: string | Buffer) => chunks.push(show(c)));
    r.on("end", () => {
      console.log(label, "end", chunks.join(","), r.readableEncoding);
      resolve();
    });
    r.on("error", (e: NodeJS.ErrnoException) => {
      console.log(label, "error", e.name, e.code, e.message);
      resolve();
    });
  });
}

async function literals(): Promise<void> {
  await collect("utf8 object", Readable.from(["a", "bc"], { encoding: "utf8" }));
  await collect("utf-8 alias", Readable.from(["4142", "43"], { encoding: "utf-8" }));
  await collect(
    "hex bytes",
    Readable.from(["4142", "43"], { objectMode: false, encoding: "hex" }),
  );
  await collect(
    "binary bytes",
    Readable.from(["ab"], { objectMode: false, encoding: "binary" }),
  );
  await collect("base64 single", Readable.from(Buffer.from("hi"), { encoding: "base64" }));
  await collect("hex object strings", Readable.from(["4142", "43"], { encoding: "hex" }));
  await collect(
    "base64 buffers object",
    Readable.from([Buffer.from("hi"), Buffer.from("yo")], { encoding: "base64" }),
  );
  await collect(
    "base64 buffers bytes",
    Readable.from([Buffer.from("hi")], { objectMode: false, encoding: "base64" }),
  );
  async function* gen(): AsyncGenerator<string> {
    yield "aa";
    yield "bb";
  }
  await collect("gen hex bytes", Readable.from(gen(), { objectMode: false, encoding: "hex" }));
}

async function runtimeEncodings(): Promise<void> {
  const hex: string = "hex";
  const empty: string = "";
  const unknown: string = "bogus";
  await collect("rt hex", Readable.from(["4142"], { objectMode: false, encoding: hex }));
  await collect("rt empty", Readable.from(["x", "y"], { encoding: empty }));
  const fromEmpty = Readable.from(["z"], { encoding: empty });
  console.log("rt empty state", fromEmpty.readableEncoding, fromEmpty.readableObjectMode);
  try {
    Readable.from(["a"], { encoding: unknown });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("rt unknown", err.name, err.code, err.message);
  }
  try {
    Readable.from(["a"], { encoding: "bogus" });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("literal unknown", err.name, err.code, err.message);
  }
  try {
    Readable.from(["a"], { encoding: "bogus", highWaterMark: -1 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("unknown then hwm", err.name, err.code, err.message);
  }
}

async function aborted(label: string, r: Readable, controller: AbortController): Promise<void> {
  const events: string[] = [];
  r.on("error", (e: NodeJS.ErrnoException) =>
    events.push(`error ${e.name} ${e.code} ${e.message} ${e.cause instanceof Error}`),
  );
  r.on("data", (c: string) => events.push(`data ${c}`));
  r.on("close", () => events.push(`close destroyed=${r.destroyed}`));
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(label, events.join(" | "));
}

async function signals(): Promise<void> {
  const okController = new AbortController();
  await collect("signal quiet", Readable.from(["s1", "s2"], { signal: okController.signal }));
  const before = new AbortController();
  await aborted("abort before read", Readable.from(["a", "b"], { signal: before.signal }), before);
  const reasoned = new AbortController();
  const reason = new Error("nope");
  reasoned.abort(reason);
  await aborted(
    "abort with reason",
    Readable.from(["a"], { encoding: "utf8", signal: reasoned.signal }),
    reasoned,
  );
  const already = new AbortController();
  already.abort();
  await aborted("already aborted", Readable.from(["a"], { signal: already.signal }), already);
  async function* slow(): AsyncGenerator<string> {
    yield "g1";
    yield "g2";
  }
  const gen = new AbortController();
  await aborted("generator abort", Readable.from(slow(), { signal: gen.signal }), gen);
  const notASignal = 123 as unknown as AbortSignal;
  try {
    Readable.from(["a"], { signal: notASignal });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("bad signal", err.name, err.code, err.message);
  }
  try {
    Readable.from(["a"], { encoding: "bogus", signal: notASignal });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("encoding before signal", err.name, err.code, err.message);
  }
}

async function main(): Promise<void> {
  await literals();
  await runtimeEncodings();
  await signals();
}

await main();
