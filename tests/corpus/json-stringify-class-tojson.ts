// JSON.stringify of a class instance whose class (or a base) declares
// toJSON serializes what toJSON(key) returns: the root key is "", nested
// hooks run through the same walker, and a toJSON answering undefined
// makes the whole result undefined.
class Url {
  href: string;
  constructor(href: string) {
    this.href = href;
  }
  toJSON(): string {
    return this.href;
  }
}
class NextUrl extends Url {
  base = "ignored";
}
class Keyed {
  toJSON(key: string): { key: string; at: Url[] } {
    return { key, at: [new Url("n")] };
  }
}
class Missing {
  toJSON(): undefined {
    return undefined;
  }
}
console.log(JSON.stringify(new Url("http://x/")));
console.log(JSON.stringify(new NextUrl("http://y/")));
console.log(JSON.stringify(new Keyed()));
console.log(JSON.stringify(new Keyed(), null, 2));
function serialize(value: Missing): string {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined result" : `text ${text}`;
}
console.log(serialize(new Missing()), JSON.stringify(new Missing()) === undefined);
let calls = 0;
class Counted {
  toJSON(): number {
    calls++;
    return calls;
  }
}
const c = new Counted();
console.log(JSON.stringify(c), JSON.stringify(c), calls);
