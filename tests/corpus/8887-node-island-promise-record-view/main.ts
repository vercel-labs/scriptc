// @requires-libnode
// A promise an island returns is adopted, not converted, so the island
// value that crosses is the one it settles with. When the program types
// that value with its own record (`later<Rec>()`), the record is a type
// that receives island values and is a live view (wave-2 6 = C): the
// awaited value is the island's own object, with its identity and the
// island's later writes. The marking used to stop at the promise, so the
// payload met a native record type and the await threw
// "expected object at $, got Object".
import { fail, later, laterOf, same, touch } from "later-pkg";

interface Rec {
  n: number;
  tag: string;
}

async function viaReturn(): Promise<Rec> {
  return later<Rec>();
}

async function main(): Promise<void> {
  // 1. The reported shape, with identity and a later island write.
  const r = await later<Rec>();
  console.log(r.n, r.tag, same(r));
  touch();
  console.log(r.n);

  // 2. Reactions and combinators receive the same value.
  await later<Rec>().then((value) => console.log("then", value.n, same(value)));
  const [a, b] = await Promise.all([later<Rec>(), later<Rec>()]);
  console.log(a.n, b.tag, same(a), same(b));
  const raced = await Promise.race([later<Rec>()]);
  console.log(raced.tag, same(raced));
  const any = await Promise.any([later<Rec>()]);
  console.log(any.n);
  const last = await later<Rec>().finally(() => console.log("finally"));
  console.log(last.tag);
  const chained = await later<Rec>()
    .then((value) => value)
    .catch(() => null);
  console.log(chained?.n);

  // 3. Through an async function's return, a typed binding and a union.
  const returned = await viaReturn();
  console.log(returned.n, same(returned));
  const pending: Promise<Rec> = later<Rec>();
  const held = await pending;
  console.log(held.n);
  const optional = await later<Rec | undefined>();
  console.log(optional?.n);

  // 4. A rejection keeps its error.
  try {
    await fail<Rec>();
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }

  // 5. A literal crosses in as a copy the island keeps; the program's own
  // record comes back as itself.
  const copy = await laterOf<Rec>({ n: 3, tag: "literal" });
  console.log(copy.n, copy.tag, same(copy));
  const mine: Rec = { n: 5, tag: "mine" };
  const back = await laterOf(mine);
  console.log(back === mine, back.n, same(mine));
  touch();
  console.log(mine.n, back.n);
}

main();
