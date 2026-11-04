// A generic helper instantiated with an async generator at a non-variable
// argument position: the argument's channels (`AsyncGenerator<T>` is
// spelled <T, any, any>) differ from the parameter's (`AsyncIterable<T>`:
// no completion value, a dyn next channel), so the call needs the async
// retype adapter on an argument that is not an lvalue. pi hit this at
// `retryGoogleRequest(stream())` ("assignment to non-variables …,
// instantiating 'retryGoogleRequest' with <AsyncGenerator<unknown, unknown,
// unknown>>").
async function* numbers(): AsyncGenerator<number> {
  yield 1;
  yield 2;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}

async function report<T>(source: AsyncIterable<T>): Promise<void> {
  console.log("reported", (await collect(source)).join(","));
}

async function main(): Promise<void> {
  // Inline argument: the adapter result has no variable to assign.
  const values = await collect(numbers());
  console.log("values", values.join(","));
  await report(numbers());
  await report(numbers());
  console.log("done");
}

void main();
