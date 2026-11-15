// A concat argument with several possible values: the bound is the product
// of them, so both loads name a module the selector knows.
interface K {
  kind: string;
}

async function load(ext: string): Promise<string> {
  const m = (await import("./part".concat(ext))) as K;
  return m.kind;
}

async function main(): Promise<void> {
  console.log(await load(".a.ts"), await load(".b.ts"));
}

void main();
