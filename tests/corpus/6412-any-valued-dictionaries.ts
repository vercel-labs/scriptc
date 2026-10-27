// Message types whose members are typed with `any`: string-keyed
// dictionaries of `any` values (`{ [key: string]: any }`, a `Dictionary<T =
// any>` alias used bare), and `any[]` lists, also optional, nested in
// arrays of records. Values keep whatever the program or JSON stored.
type Dictionary<T = any> = { [key: string]: T };

interface Build {
  use: string;
  src?: string;
  config?: Dictionary;
}
interface Order {
  id: string;
  builds?: Build[];
  upload: { url: string; fields: { [key: string]: any } };
  tags: any[];
  extra?: any[];
}

function tags(): Dictionary<any> {
  return { a: 1, b: "x", c: [1, 2] };
}
async function meta(): Promise<Dictionary> {
  return { n: 3 };
}

async function main(): Promise<void> {
  const order: Order = JSON.parse(
    '{"id":"o1","builds":[{"use":"node","config":{"zero":true,"n":2}},{"use":"static","src":"a/**"}],' +
      '"upload":{"url":"u","fields":{"k":"v","n":2}},"tags":[1,"two",null]}',
  );
  console.log(order.id, order.upload.url, String(order.upload.fields.k), order.upload.fields["n"] + 1);
  for (const build of order.builds ?? []) {
    console.log(build.use, build.src ?? "-", JSON.stringify(build.config ?? null));
  }
  console.log(order.tags.length, order.extra === undefined, JSON.stringify(order.tags));

  const t = tags();
  for (const k of Object.keys(t)) console.log(k, JSON.stringify(t[k]));
  t.d = { deep: true };
  console.log(JSON.stringify(t));
  const m = await meta();
  console.log(m.n * 2, JSON.stringify(m));

  const made: Order = { id: "o2", upload: { url: "w", fields: {} }, tags: [], extra: [0] };
  made.upload.fields.signature = "s";
  made.tags.push({ k: 1 });
  console.log(JSON.stringify(made));
}
void main();
