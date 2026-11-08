// A spread argument supplies any number of values, so the parameter's value
// is not the argument written at its index, nor its default when nothing is
// written there: `spec` receives `pair[1]` here, and a bound of the default
// alone would miss it. The load refuses with the call that spreads.
async function load(tag: string, spec: string = "node:os"): Promise<unknown> {
  const m = await import(spec);
  return [tag, m];
}

const pair: [string, string] = ["tag", "node:path"];
void load(...pair);
