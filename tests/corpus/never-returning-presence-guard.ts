// A read guarded by a call that never returns (`if (x === undefined) fail()`)
// is present after the guard, as it is after `throw`. A string[] that such
// reads fill then holds no undefined elements, so the program's string[]
// elements still write to stdout as strings.
function fail(what: string): never {
  throw new Error(what);
}

const words: string[] = ["alpha", "beta"];
function word(index: number): string {
  const known = words[index];
  if (known === undefined) fail(`no word at ${index}`);
  return known;
}

class Names {
  private readonly names: string[] = ["gamma"];
  private missing(): never {
    throw new RangeError("no name");
  }
  first(): string {
    const name = this.names[0];
    if (name === undefined) this.missing();
    return name;
  }
}

function collect(): string[] {
  const out: string[] = [];
  out.push(word(0));
  out.push(word(1));
  out.push(new Names().first());
  return out;
}

console.log(collect().join(" "));
const parts: string[] = JSON.stringify({ a: 1, b: [2, 3] }).split(",");
for (const part of parts) {
  process.stdout.write(part);
  process.stdout.write("\n");
}
try {
  word(5);
} catch (error) {
  if (error instanceof Error) console.log(error.message);
}

// Behind `?.`, a missing reporter skips the call, so the read after it can
// still be undefined.
class Reporter {
  fail(what: string): never {
    throw new Error(what);
  }
}
const reporters: Reporter[] = [];
function maybeWord(index: number): string {
  const known = words[index];
  if (known === undefined) reporters[index]?.fail(`no word at ${index}`);
  return known;
}
const missing = maybeWord(7);
console.log(maybeWord(1), missing === undefined, typeof missing);
