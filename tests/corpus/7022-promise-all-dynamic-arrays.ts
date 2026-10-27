// Promise.all over arrays built from 'any' values: the argument is a
// runtime value, so the combinator reads it with Node's iteration and
// resolves each entry (promises, thenables and plain values).
interface Check {
  name: string;
  ok: boolean;
}
async function check(name: string): Promise<Check> {
  await null;
  return { name, ok: name.length > 2 };
}

async function main(): Promise<void> {
  const raw: any = JSON.parse('{"items":[{"name":"abc"},{"name":"x"}],"ids":[1,2,3]}');
  const results = await Promise.all(raw.items.map((item: any) => check(item.name)));
  for (const r of results) console.log(r.name, r.ok);
  const doubled = await Promise.all(raw.ids.map(async (id: number) => id * 2));
  console.log(doubled.join(","), doubled.length);
  const mixed = await Promise.all(raw.ids.map((id: number) => (id % 2 ? id : Promise.resolve(-id))));
  console.log(JSON.stringify(mixed));
  const parsed: unknown = JSON.parse('["a","bb","ccc"]');
  const list = Array.isArray(parsed) ? parsed : [];
  const lengths = await Promise.all(list.map(async (s) => String(s).length));
  console.log(lengths, lengths.reduce((a, b) => a + b, 0));
  const empty: any = [];
  console.log(JSON.stringify(await Promise.all(empty)));
  try {
    await Promise.all(raw.items.map(async (item: any) => {
      if (item.name === "x") throw new Error(`bad ${item.name}`);
      return item.name;
    }));
  } catch (e) {
    console.log("rejected", (e as Error).message);
  }
  try {
    await Promise.all(raw.missing);
  } catch (e) {
    console.log("not iterable", e instanceof TypeError);
  }
}
void main();
