// ReadableStream.from over iterables: a compiled generator steps the
// iterator protocol, as an async generator and a Set do, while arrays,
// strings and Uint8Array keep the native walk. Node's stream pulls one
// chunk per read and closes the iterator on cancel, so the chunks, the
// errors and the cancel agree.
function* numbers(): Generator<number, void, unknown> {
  yield 1;
  yield 2;
  yield 3;
}
async function* letters(): AsyncGenerator<string, void, unknown> {
  yield "a";
  yield "b";
}
function* tracked(events: string[]): Generator<number, void, unknown> {
  try {
    yield 1;
    yield 2;
  } finally {
    events.push("closed");
  }
}
function* failing(): Generator<number, void, unknown> {
  yield 1;
  throw new Error("late");
}
async function collect(stream: ReadableStream<number | string>): Promise<string> {
  const out: string[] = [];
  const reader = stream.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    out.push(String(step.value));
  }
  return out.join(",");
}

function thrown(label: string, fn: () => unknown): void {
  try {
    fn();
    console.log(label, "no error");
  } catch (e) {
    const error = e as Error & { code?: string };
    console.log(label, error.name, String(error.code), error.message);
  }
}

async function main(): Promise<void> {
  console.log("generator", await collect(ReadableStream.from(numbers())));
  console.log("async generator", await collect(ReadableStream.from(letters())));
  console.log("array", await collect(ReadableStream.from([4, 5])));
  console.log("string", await collect(ReadableStream.from("hi")));
  console.log("bytes", await collect(ReadableStream.from(new Uint8Array([7, 8]))));
  console.log("set", await collect(ReadableStream.from(new Set(["x", "y"]))));

  const events: string[] = [];
  const stream = ReadableStream.from(tracked(events));
  const reader = stream.getReader();
  console.log("cancel first", (await reader.read()).value);
  await reader.cancel("stop");
  console.log("cancel events", JSON.stringify(events), "locked", stream.locked);

  try {
    await collect(ReadableStream.from(failing()));
  } catch (e) {
    console.log("failing", (e as Error).message);
  }

  thrown("no argument", () => ReadableStream.from(undefined as never));
  thrown("not iterable", () => ReadableStream.from({} as never));
  thrown("bad iterator", () => ReadableStream.from({ [Symbol.iterator]: () => 5 } as never));
}

void main();
