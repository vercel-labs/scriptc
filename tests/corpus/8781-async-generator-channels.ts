// An async generator whose channels differ from the slot it flows into
// steps through an async adapter generator: the lib default
// `AsyncGenerator<T>` spells <T, any, any>, so a value whose completion
// value is dyn (or whose next channel is dyn) entering an
// `AsyncGenerator<T, void, unknown>` return, or an `AsyncIterable<T>`
// parameter, converts between the channels instead of being refused. The
// completion value is dropped when the slot carries none, values keep their
// order and laziness, `.next(v)` values are forwarded, an early exit closes
// the source, and a throwing source rejects the consumer.
interface Event {
  kind: string;
  value: number;
}

async function* events(): AsyncGenerator<Event> {
  yield { kind: "a", value: 1 };
  yield { kind: "b", value: 2 };
  yield { kind: "c", value: 3 };
  return { kind: "end", value: 0 };
}

// The slot carries neither a completion value nor a sent value.
function asStream(): AsyncGenerator<Event, void, unknown> {
  return events();
}

async function collect(source: AsyncIterable<Event>): Promise<string> {
  const parts: string[] = [];
  for await (const event of source) parts.push(`${event.kind}${event.value}`);
  return parts.join(",");
}

async function* counting(): AsyncGenerator<number> {
  let i = 0;
  try {
    while (true) yield i++;
  } finally {
    console.log("source closed after", i);
  }
}

async function take(source: AsyncIterable<number>, limit: number): Promise<void> {
  for await (const value of source) {
    console.log("took", value);
    if (value >= limit) break;
  }
}

// The next channel is dyn at the source and narrows at the slot, so the
// values a consumer sends are forwarded into the source.
async function* echoing(): AsyncGenerator<string, void, unknown> {
  let total = 0;
  for (let i = 0; i < 2; i++) {
    const sent = yield `step${i}`;
    total += typeof sent === "number" ? sent : 0;
  }
  console.log("sent total", total);
}

function asNumberEcho(): AsyncGenerator<string, void, number> {
  return echoing();
}

async function* failing(): AsyncGenerator<number> {
  yield 1;
  throw new Error("boom");
}

async function main(): Promise<void> {
  console.log("stream", await collect(asStream()));

  // The completion value never reaches a slot that carries none.
  const stream = asStream();
  const first = await stream.next();
  console.log("first", first.done === false, (first.value as Event).kind);
  console.log("rest", await collect(stream));

  await take(counting(), 2);

  const echo = asNumberEcho();
  console.log("echo", (await echo.next(0)).value);
  console.log("echo", (await echo.next(5)).value);
  const done = await echo.next(7);
  console.log("echo done", done.done === true);

  try {
    for await (const value of failing()) console.log("failing", value);
    console.log("no throw");
  } catch (e) {
    console.log("rejected", (e as Error).message);
  }
  console.log("done");
}

void main();
