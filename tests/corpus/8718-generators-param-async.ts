// Async generators bind their parameters at the call too: a nullish
// destructuring argument throws SYNCHRONOUSLY from the call (Node never
// returns an async generator it could not bind), an initializer's side
// effects happen at the call, and a successful binding still defers the body
// to the first next().
interface Shape {
  a: number;
}

const events: string[] = [];
let bodies = 0;

async function* fromShape({ a }: Shape): AsyncGenerator<number, number, undefined> {
  bodies++;
  yield a;
  return -1;
}

function note(name: string): string {
  events.push(name);
  return name;
}

async function* defaults(first: string = note("first")): AsyncGenerator<string, void, undefined> {
  bodies++;
  yield first;
}

const shape = { a: 5 };
const nothing: Shape | null = null;

async function main(): Promise<void> {
  events.push("start");
  try {
    fromShape(nothing as Shape);
    console.log("no throw");
  } catch (e) {
    console.log("call threw", e instanceof TypeError);
  }
  events.push("after failed call");

  // The initializer runs during the call, before the next statement.
  const withDefault = defaults();
  events.push("after call");
  console.log(events.join(","));
  console.log("bodies", bodies);

  const first = await withDefault.next();
  console.log(first.done === false, first.value as string, bodies);
  console.log((await withDefault.next()).done === true);

  // A successful binding: only the prologue ran at the call.
  const ok = fromShape(shape);
  console.log("created", bodies);
  const r = await ok.next();
  console.log(r.done === false, r.value as number, bodies);
  console.log((await ok.next()).done === true);

  // .return() and .throw() before the first next() complete the generator
  // without ever running its body.
  const a1 = fromShape(shape);
  const ret = await a1.return(9);
  console.log("return", ret.done === true, ret.value as number, bodies);
  const a2 = fromShape(shape);
  try {
    await a2.throw(new Error("injected"));
    console.log("no throw");
  } catch (e) {
    console.log("throw", (e as Error).message, bodies);
  }

  // An async generator method binds at the call as well.
  const holder = {
    async *values({ a }: Shape): AsyncGenerator<number, void, undefined> {
      bodies++;
      yield a;
    },
  };
  try {
    holder.values(nothing as Shape);
    console.log("no throw");
  } catch (e) {
    console.log("method threw", e instanceof TypeError);
  }
  const holderGen = holder.values(shape);
  const m = await holderGen.next();
  console.log(m.value as number, bodies);
  console.log((await holderGen.next()).done === true);
  console.log("done");
}

void main();
