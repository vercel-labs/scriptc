// Packages the program loads only through import() run in Node islands.
// Several of them loaded by ONE statement are all decided together: the
// entries of a Promise.all, imports nested in one expression, a condition
// with the block it guards, and a function written inside the statement.
// Every form loads each package once and reads what it exports.
async function together(): Promise<string> {
  const [gauge, ruler, level] = await Promise.all([
    import("gauge-kit"),
    import("ruler-kit"),
    import("level-kit"),
  ]);
  return [gauge.gaugeOf(1), ruler.rulerOf(2), level.levelOf(3)].join(" ");
}

async function nested(): Promise<number> {
  return (await import("gauge-kit")).gaugeOf(
    (await import("ruler-kit")).rulerOf(4).length + (await import("level-kit")).levelOf(5).length,
  ).length;
}

async function guarded(): Promise<string[]> {
  const seen: string[] = [];
  if ((await import("level-kit")).levelOf(6).length > 0) {
    const ruler = await import("ruler-kit");
    seen.push(ruler.rulerOf(7));
    seen.push(new (await import("gauge-kit")).Reading(8).show());
  }
  return seen;
}

async function later(): Promise<string> {
  const [gauge, read] = [
    await import("gauge-kit"),
    async (n: number) => (await import("ruler-kit")).rulerOf(n),
  ];
  return gauge.gaugeOf(9) + " " + (await read(10));
}

async function main(): Promise<void> {
  console.log(await together());
  console.log(await nested());
  console.log((await guarded()).join(" "));
  console.log(await later());
  const [first, again] = await Promise.all([import("gauge-kit"), import("gauge-kit")]);
  console.log(first === again, first.gaugeOf(11));
}

main().then(() => console.log("done"));
