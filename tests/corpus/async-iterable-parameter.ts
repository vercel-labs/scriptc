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

async function collect(source: AsyncIterableIterator<number>): Promise<string> {
  const seen: string[] = [];
  for await (const value of source) {
    seen.push(String(value));
    if (value >= 2) break;
  }
  return seen.join(",");
}

async function main(): Promise<void> {
  console.log("sum", await sum(numbers(4)));
  console.log("first", await firstOf(numbers(3)));
  console.log("doubled", await sum(doubled(numbers(3))));
  console.log("collect", await collect(numbers(5)));
}

void main();
