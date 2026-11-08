// The same specifier written literally and reached through a parameter: each
// site keeps its own answer, so the bounded arm still names its module.
interface K {
  kind: string;
}

async function load(p: string): Promise<string> {
  const m = (await import(p)) as K;
  return m.kind;
}

async function main(): Promise<void> {
  const lit = (await import("./a.ts")) as K;
  console.log(lit.kind, await load("./a.ts"));
}

void main();
