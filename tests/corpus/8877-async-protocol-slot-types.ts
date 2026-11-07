// One program, two kinds of async-iteration protocol slot. The slots over
// `number` only ever receive compiled async generators and keep the typed
// generator stepping. The slots over `string`, `boolean` and `Entry` receive
// objects that implement the protocol themselves (a class, an object
// literal, a class behind a union, a promise, a field and an array), so they
// hold the checked-dynamic value and `for await` runs the protocol on
// whatever arrives, compiled generators included. Either way the loops take
// the turns Node's do, which the interleaved output of concurrent consumers
// shows.
async function* numbers(max: number): AsyncGenerator<number, void, unknown> {
  for (let i = 1; i <= max; i++) yield i;
}

async function sum(source: AsyncIterable<number>): Promise<number> {
  let total = 0;
  for await (const value of source) total += value;
  return total;
}

async function firstOf(source: AsyncIterator<number>): Promise<number> {
  const result = await source.next();
  return result.done === true ? -1 : result.value;
}

async function* doubled(source: AsyncIterable<number>): AsyncGenerator<number, void, unknown> {
  for await (const value of source) yield value * 2;
}

class Words implements AsyncIterable<string> {
  private readonly words: string[];
  opened = 0;
  constructor(words: string[]) {
    this.words = words;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    this.opened++;
    for (const word of this.words) yield word;
  }
}

async function* letters(text: string): AsyncIterableIterator<string> {
  for (const letter of text) yield letter;
}

async function join(source: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const word of source) text += word;
  return text;
}

// The slot type behind a union and behind an optional parameter.
async function joinOr(source: AsyncIterable<string> | undefined, missing: string): Promise<string> {
  return source === undefined ? missing : join(source);
}

async function joinOptional(source?: AsyncIterable<string>): Promise<string> {
  if (!source) return "none";
  let text = "";
  for await (const word of source) text += `<${word}>`;
  return text;
}

// A return slot and a promise's payload.
function flags(count: number): AsyncIterable<boolean> {
  let n = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<boolean>> {
          n++;
          return n <= count
            ? Promise.resolve({ value: n % 2 === 1, done: false })
            : Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };
}

async function laterFlags(count: number): Promise<AsyncIterable<boolean>> {
  return flags(count);
}

async function countTrue(source: AsyncIterable<boolean>): Promise<number> {
  let count = 0;
  for await (const flag of source) if (flag) count++;
  return count;
}

// A field and an array element.
interface Entry {
  key: string;
  size: number;
}

class Entries implements AsyncIterable<Entry> {
  async *[Symbol.asyncIterator](): AsyncIterator<Entry> {
    yield { key: "a", size: 1 };
    yield { key: "b", size: 2 };
  }
}

async function* moreEntries(): AsyncGenerator<Entry, void, unknown> {
  yield { key: "c", size: 3 };
}

interface Job {
  name: string;
  input: AsyncIterable<Entry>;
}

async function run(job: Job): Promise<string> {
  let size = 0;
  const keys: string[] = [];
  for await (const entry of job.input) {
    size += entry.size;
    keys.push(entry.key);
  }
  return `${job.name}:${keys.join("")}:${size}`;
}

async function runAll(inputs: AsyncIterable<Entry>[]): Promise<number> {
  let count = 0;
  for (const input of inputs) for await (const _ of input) count++;
  return count;
}

// Generic functions: an element type that names the type parameter, and a
// generic body forwarding its source into a slot over another element type.
class Gaps implements AsyncIterable<string | null> {
  async *[Symbol.asyncIterator](): AsyncIterator<string | null> {
    yield "g";
    yield null;
    yield "h";
  }
}

async function present<T>(source: AsyncIterable<T | null>): Promise<T[]> {
  const kept: T[] = [];
  for await (const item of source) if (item !== null) kept.push(item);
  return kept;
}

async function countAll(source: AsyncIterable<unknown>): Promise<number> {
  let total = 0;
  for await (const _ of source) total++;
  return total;
}

function forward<T>(source: AsyncIterable<T>): Promise<number> {
  return countAll(source);
}

// Two consumers running at once: each line is printed in the turn Node
// prints it in.
async function trace(label: string, source: AsyncIterable<string>): Promise<void> {
  for await (const item of source) console.log(label, item);
  console.log(label, "end");
}

async function traceNumbers(label: string, source: AsyncIterable<number>): Promise<void> {
  for await (const item of source) console.log(label, item);
  console.log(label, "end");
}

async function main(): Promise<void> {
  console.log("sum", await sum(numbers(4)));
  console.log("first", await firstOf(numbers(3)));
  console.log("doubled", await sum(doubled(numbers(3))));

  const words = new Words(["a", "b", "c"]);
  console.log("join", await join(words), await join(letters("xyz")));
  // An iterable opens again for every loop; a generator does not.
  console.log("again", await join(words), words.opened);
  const once = letters("pq");
  console.log("once", await join(once), JSON.stringify(await join(once)));

  // An untyped value that implements the protocol enters the same slot.
  const untyped: any = new Words(["u", "v"]);
  console.log("untyped", await join(untyped));

  console.log("union", await joinOr(words, "?"), await joinOr(undefined, "?"));
  console.log("optional", await joinOptional(letters("hi")), await joinOptional());

  console.log("flags", await countTrue(flags(5)), await countTrue(await laterFlags(4)));

  console.log("field", await run({ name: "class", input: new Entries() }));
  console.log("field", await run({ name: "generator", input: moreEntries() }));
  console.log("array", await runAll([new Entries(), moreEntries(), new Entries()]));

  console.log("generic", (await present(new Gaps())).join(""), await forward(new Words(["x", "y"])));
  console.log("generic", await forward(letters("abc")), await forward(new Entries()));

  await Promise.all([
    trace("w", new Words(["1", "2"])),
    trace("g", letters("ab")),
    traceNumbers("n", numbers(2)),
    traceNumbers("d", doubled(numbers(2))),
  ]);
}

await main();
