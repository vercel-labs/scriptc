// A parameter the function body writes holds a value no caller passed at the
// load site, so the call arguments cannot bound the specifier: the load
// refuses with the reason instead of building a selector that misses it.
async function load(p: string): Promise<unknown> {
  p = "./other.ts";
  const m = await import(p);
  return (m as { kind: string }).kind;
}

void load("./a.ts");
