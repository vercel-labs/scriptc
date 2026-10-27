// Records whose fields TypeScript types `any` convert into declared
// record types: each such field is checked against the declared type,
// as a typed binding initialized from the value is.
interface Transfer {
  source: string;
  targetId: string;
  bytes: number;
  tags: string[];
}
const meta: any = JSON.parse('{"id":"x-1","size":4,"tags":["a","b"]}');

const mapped: Transfer[] = ["a", "b"].map((s, i) => ({
  source: s,
  targetId: meta.id,
  bytes: meta.size + i,
  tags: meta.tags,
}));
console.log(JSON.stringify(mapped));

function build(): Transfer {
  const record = { source: "c", targetId: meta.id, bytes: meta.size, tags: [] as string[] };
  return record;
}
console.log(JSON.stringify(build()));

const list: Transfer[] = [];
for (const entry of [{ source: "d", targetId: meta.id, bytes: 1, tags: meta.tags }]) list.push(entry);
console.log(list.length, list[0]!.targetId.toUpperCase(), list[0]!.tags.length);
