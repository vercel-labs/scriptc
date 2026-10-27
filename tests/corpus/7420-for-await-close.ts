// Leaving a for await loop over an async generator early closes it, as
// AsyncIteratorClose does: return, throw and break inside the body, a
// labeled continue to an outer loop, and a return() at a yield in the
// body all await the generator's return(), so its finally runs before the
// loop's caller continues. An exhausted generator and a rejected next()
// are not closed. After a throw, an error from closing is dropped; after
// a break or return it propagates.
const log: string[] = [];

async function* numbers(tag: string, failClose = false): AsyncGenerator<number> {
  try {
    yield 1;
    yield 2;
    yield 3;
  } finally {
    log.push(`${tag} finally`);
    if (failClose) throw new Error(`${tag} close failed`);
  }
}

async function* slowClose(tag: string): AsyncGenerator<number> {
  try {
    yield 1;
  } finally {
    await null;
    log.push(`${tag} finally after await`);
  }
}

async function firstOf(tag: string): Promise<number> {
  for await (const n of numbers(tag)) return n * 10;
  return -1;
}

async function throwsInside(tag: string): Promise<void> {
  for await (const n of numbers(tag)) throw new Error(`${tag} body ${n}`);
}

async function* takeOne(tag: string): AsyncGenerator<number> {
  for await (const n of numbers(tag)) {
    yield n;
    return;
  }
}

async function* rethrowing(tag: string): AsyncGenerator<string> {
  for await (const n of numbers(tag)) {
    if (n === 2) throw new Error(`${tag} at ${n}`);
    yield `${tag} ${n}`;
  }
}

async function main(): Promise<void> {
  log.push(`first ${await firstOf("return")}`);
  try {
    await throwsInside("throw");
  } catch (e) {
    log.push(`caught ${(e as Error).message}`);
  }
  for await (const n of takeOne("generator-return")) log.push(`took ${n}`);
  try {
    for await (const s of rethrowing("generator-throw")) log.push(s);
  } catch (e) {
    log.push(`caught ${(e as Error).message}`);
  }
  const early = takeOne("consumer-return");
  for await (const n of early) {
    log.push(`consumer got ${n}`);
    break;
  }
  try {
    for await (const n of numbers("break-close-fails", true)) {
      log.push(`break at ${n}`);
      break;
    }
  } catch (e) {
    log.push(`caught ${(e as Error).message}`);
  }
  try {
    for await (const n of numbers("throw-close-fails", true)) throw new Error(`body ${n}`);
  } catch (e) {
    log.push(`caught ${(e as Error).message}`);
  }
  void Promise.resolve().then(() => log.push("microtask"));
  for await (const n of slowClose("slow")) {
    log.push(`slow ${n}`);
    break;
  }
  log.push("after slow");
  outer: for (const k of [1, 2]) {
    for await (const n of numbers(`labeled ${k}`)) {
      log.push(`labeled ${k} got ${n}`);
      continue outer;
    }
  }
  for await (const n of numbers("exhausted")) log.push(`exhausted ${n}`);
  for (const line of log) console.log(line);
}

void main();
