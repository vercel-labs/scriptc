// A stackless async body's frame holds the values live across its awaits,
// and the runtime recycles frames through its small-block free lists. Every
// call must see a zeroed frame, a branch that assigns a slot only sometimes
// must not observe the previous call's value, and a throw must not leave the
// frame's references counted. The reuse is stressed back to back and
// concurrently, and Promise.all's turns, including a rejection, are pinned
// against Node.
const log: string[] = [];

interface Entry {
  id: number;
  label: string;
}

const entries: Entry[] = [];
for (let i = 0; i < 8; i++) entries.push({ id: i, label: "e" + i });

async function settle(n: number): Promise<string> {
  return entries[n % entries.length]!.label;
}

async function step(n: number): Promise<number> {
  // Assigned on one branch only: a recycled frame that is not zeroed hands
  // this call the previous one's entry.
  let partial: Entry | undefined;
  if (n % 3 === 0) partial = entries[n % entries.length]!;
  const first = await settle(n);
  const second = await settle(n + 1);
  if (n % 11 === 0) throw new Error(`step ${n} (${first}${second})`);
  return (partial === undefined ? 0 : partial.id) + n;
}

async function main(): Promise<void> {
  let total = 0;
  let failures = 0;
  for (let i = 1; i <= 300; i++) {
    try {
      total += await step(i);
    } catch (error) {
      failures++;
      if (failures <= 3) log.push(`sequential caught ${(error as Error).message}`);
    }
  }
  log.push(`sequential total ${total} failures ${failures}`);

  const batch = [step(301), step(302), step(303), step(304)];
  const values = await Promise.all(batch);
  log.push(`batch ${values.join(",")}`);

  const literal = await Promise.all([settle(1), settle(2), settle(3)]);
  log.push(`literal ${literal.join(",")}`);

  try {
    const rejected = await Promise.all([settle(4), step(11), settle(5)]);
    log.push(`rejected resolved ${rejected.length}`);
  } catch (error) {
    log.push(`rejected caught ${(error as Error).message}`);
  }

  const local = [step(305), step(306)];
  try {
    const pair = await Promise.all(local);
    log.push(`local ${pair.join(",")}`);
  } catch (error) {
    log.push(`local caught ${(error as Error).message}`);
  }

  for (const line of log) console.log(line);
}
void main();
