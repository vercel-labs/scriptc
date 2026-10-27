// An object literal spreading an untyped (`any`) source into a typed slot
// copies the source's runtime properties, then checks the copy into the
// slot's type like any other `any` value.
interface Filter {
  readonly genre?: string;
  readonly sort: string;
  readonly offset: number;
  readonly limit: number;
}

function untyped(text: string): any {
  return JSON.parse(text);
}

function describe(filter: Filter): string {
  return `${filter.genre ?? "(any genre)"} sorted by ${filter.sort}, ${filter.offset}..${filter.offset + filter.limit}`;
}

function main(): void {
  const query = untyped('{"genre":"poetry","sort":"title","offset":20,"limit":10}');
  console.log(describe({ ...query, offset: 0, limit: 100 }));
  console.log(describe({ offset: 5, ...query }));
  const merged: Filter = { sort: "added", offset: 0, limit: 20, ...untyped('{"limit":3}') };
  console.log(merged.sort, merged.offset, merged.limit, merged.genre === undefined);
  const copy: { a: number; b: string } = { ...untyped('{"a":1,"b":"x"}'), b: "y" };
  console.log(copy.a + 1, copy.b, JSON.stringify(copy));
  let latest: { a: number } = { a: 0 };
  latest = { ...untyped('{"a":4}') };
  console.log(latest.a);
}

main();
