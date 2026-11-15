// ReadableStream.from over iterables in a JavaScript source: compiled
// generators and async generators, plain iterator objects, Set, Map
// entries, and the array/string/Uint8Array shapes the native walk reads.
// The stream pulls one chunk per read, and a canceled stream closes the
// iterator.
function* numbers() {
  yield 1;
  yield 2;
  yield 3;
}
async function* letters() {
  yield "a";
  yield "b";
}
function plain(source) {
  let index = 0;
  return {
    [Symbol.iterator]() {
      return {
        next() {
          if (index < source.length) return { done: false, value: source[index++] };
          return { done: true, value: undefined };
        },
      };
    },
  };
}
async function collect(stream) {
  const out = [];
  const reader = stream.getReader();
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    out.push(String(step.value));
  }
  return out.join(",");
}
function thrown(label, fn) {
  try {
    fn();
    console.log(label, "no error");
  } catch (e) {
    console.log(label, e.name, String(e.code), e.message);
  }
}

console.log("generator", await collect(ReadableStream.from(numbers())));
console.log("async generator", await collect(ReadableStream.from(letters())));
console.log("array", await collect(ReadableStream.from([4, 5])));
console.log("string", await collect(ReadableStream.from("hi")));
console.log("bytes", await collect(ReadableStream.from(new Uint8Array([7, 8]))));
console.log("set", await collect(ReadableStream.from(new Set(["x", "y"]))));
console.log("map", await collect(ReadableStream.from(new Map([["k", 1]]))));
console.log("plain", await collect(ReadableStream.from(plain([9, 10]))));

const events = [];
function* tracked() {
  try {
    yield 1;
    yield 2;
  } finally {
    events.push("closed");
  }
}
const stream = ReadableStream.from(tracked());
const reader = stream.getReader();
console.log("cancel first", (await reader.read()).value);
await reader.cancel("stop");
console.log("cancel events", JSON.stringify(events), "locked", stream.locked);

const seen = [];
const closable = ReadableStream.from({
  [Symbol.iterator]() {
    return {
      next() {
        return { done: false, value: "x" };
      },
      return(reason) {
        seen.push(reason);
        return { done: true, value: undefined };
      },
    };
  },
});
const closableReader = closable.getReader();
await closableReader.read();
await closableReader.cancel("stop");
console.log("return reason", JSON.stringify(seen));

try {
  await collect(
    ReadableStream.from({
      [Symbol.iterator]() {
        return {
          next() {
            throw new Error("next failed");
          },
        };
      },
    }),
  );
} catch (e) {
  console.log("failing", e.message);
}

thrown("no argument", () => ReadableStream.from());
thrown("not iterable", () => ReadableStream.from({}));
thrown("bad iterator", () =>
  ReadableStream.from({
    [Symbol.iterator]: () => 5,
  }),
);
