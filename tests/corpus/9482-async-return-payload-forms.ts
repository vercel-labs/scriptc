// The ways an async body hands back a promise whose record is a value of the
// declared result without being the declared record: an arrow, a method, an
// async generator's return, a return inside try/finally, and a returned
// rejection that the function's own catch never sees.
interface Entry {
  name: string;
  size?: number | string;
}

const arrow = async (name: string): Promise<Entry> =>
  Promise.resolve(name).then((n) => ({ name: n, size: n.length }));

class Reader {
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  async read(name: string): Promise<Entry> {
    return Promise.resolve(name).then((n) => ({ name: this.prefix + n, size: String(n.length) }));
  }
  static async open(name: string): Promise<Entry> {
    return Promise.resolve(name).then((n) => ({ name: n, size: 0 }));
  }
}

async function* steps(name: string): AsyncGenerator<number, Entry> {
  yield 1;
  yield 2;
  return Promise.resolve(name).then((n) => ({ name: n, size: n.length }));
}

async function guarded(name: string): Promise<Entry> {
  try {
    return Promise.resolve(name).then((n) => ({ name: n, size: n.length }));
  } finally {
    console.log("finally", name);
  }
}

async function failing(name: string): Promise<{ name: string; size: number }> {
  await null;
  throw new Error("no " + name);
}

async function notCaught(name: string): Promise<Entry> {
  try {
    return name.length > 2
      ? failing(name).then((r) => ({ ...r, size: r.size + 1 }))
      : Promise.resolve(name).then((n) => ({ name: n, size: n.length }));
  } catch {
    return { name: "caught" };
  }
}

function describe(entry: Entry): string {
  return `${entry.name} ${typeof entry.size} ${entry.size} ${JSON.stringify(entry)}`;
}

async function main(): Promise<void> {
  console.log("arrow", describe(await arrow("ab")));
  const reader = new Reader("/");
  console.log("method", describe(await reader.read("abc")));
  console.log("static", describe(await Reader.open("abcd")));
  const iterator = steps("abcde");
  let seen = 0;
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      console.log("generator", seen, describe(step.value));
      break;
    }
    seen += step.value;
  }
  console.log("guarded", describe(await guarded("ab")));
  for (const name of ["ab", "abc"]) {
    try {
      console.log("not caught", describe(await notCaught(name)));
    } catch (error) {
      console.log("not caught", "rejected:", (error as Error).message);
    }
  }
}
main();
