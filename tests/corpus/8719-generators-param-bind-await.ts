// A generator that binds its parameters at the call parks with no value in
// its yield slot, so an await afterwards must still be an await (its request
// settles when the body yields, not with the parked marker), and the
// completion must carry the body's return value. The fiber form (debug
// builds) parks the marker through a valueless yield, which is the shape
// this pins.
interface Options {
  tag: string;
}

async function* awaited({ tag }: Options): AsyncGenerator<string, string, undefined> {
  const first = await Promise.resolve(tag);
  yield `${first}:1`;
  for await (const c of ["a", "b"]) yield `${tag}:${c}`;
  return "end";
}

async function* nested({ tag }: Options): AsyncGenerator<string, void, undefined> {
  for await (const c of awaited({ tag })) yield `<${c}>`;
}

function* plain({ tag }: Options): Generator<string, void, undefined> {
  yield tag;
}

function* empty({ tag }: Options): Generator<string, void, undefined> {
  if (tag === "") return;
  yield tag;
}

async function main(): Promise<void> {
  const log: string[] = [];
  const g = awaited({ tag: "t" });
  log.push("created");
  for await (const v of g) log.push(v);
  log.push("drained");

  const manual = awaited({ tag: "m" });
  const one = await manual.next();
  log.push(`one ${one.done} ${one.value as string}`);
  const two = await manual.next();
  log.push(`two ${two.done} ${two.value as string}`);
  const stop = await manual.return("early");
  log.push(`return ${stop.done} ${stop.value as string}`);
  log.push(`after return ${(await manual.next()).done === true}`);

  const wrapped: string[] = [];
  for await (const v of nested({ tag: "n" })) wrapped.push(v);
  log.push(`nested ${wrapped.join(",")}`);

  log.push(`plain ${[...plain({ tag: "p" })].join(",")}`);
  log.push(`empty ${[...empty({ tag: "" })].length}`);
  log.push(`full ${[...empty({ tag: "f" })].join(",")}`);
  console.log(log.join("|"));
}

void main();
