// LifetimeRegion (@scriptc/experimental) with async callbacks: run(fn)
// returns fn's promise once fn first awaits, and the work that resumes
// after an await still allocates in the region. Releasing the region while
// the async work is still pending is safe: the region is not freed before
// that work has finished and nothing outside refers to its objects.
// Node.js prints the same.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

class Token implements ProgramLifetime {
  readonly text: string;
  readonly index: number;
  prev: Token | undefined = undefined;
  constructor(text: string, index: number) {
    this.text = text;
    this.index = index;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

async function tokenize(source: string): Promise<Token[]> {
  const tokens: Token[] = [];
  let prev: Token | undefined;
  const words = source.split(" ");
  for (let i = 0; i < words.length; i++) {
    const token = new Token(words[i]!, i);
    token.prev = prev;
    prev = token;
    tokens.push(token);
    if (i % 2 === 1) await tick();
  }
  return tokens;
}

async function main(): Promise<void> {
  const region = new LifetimeRegion();
  const pending = region.run(() => tokenize("let x = a + b * c ;"));
  // Released before the async work has finished.
  region.release();
  const tokens = await pending;
  console.log(tokens.map((t) => `${t.index}:${t.text}`).join(" "));
  console.log(tokens[tokens.length - 1]!.prev!.prev!.text);

  const second = new LifetimeRegion();
  const results = await second.run(async () => {
    const before = new Token("before", 0);
    await tick();
    const after = new Token("after", 1);
    after.prev = before;
    return [before, after];
  });
  second.release();
  console.log(results.map((t) => t.text).join(","), results[1]!.prev === results[0]);

  // Several regions in flight at once.
  const regions = [new LifetimeRegion(), new LifetimeRegion(), new LifetimeRegion()];
  const all = await Promise.all(regions.map((r, i) => r.run(() => tokenize(`r${i} s${i} t${i}`))));
  for (const r of regions) r.release();
  console.log(all.map((ts) => ts.map((t) => t.text).join("+")).join(" | "));
  const last = new LifetimeRegion();
  console.log(last.run(() => new Token("sync", 9)).text);
  last.release();
}

main().then(() => {
  new LifetimeRegion().release();
  console.log("done");
});
