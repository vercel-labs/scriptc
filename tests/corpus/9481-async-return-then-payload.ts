// An async function declared Promise<Outcome> returns
// `promise.then((r) => ({ ...r, structured }))`. The checker types that call
// Promise<S | Outcome>: `then`'s second type parameter takes Outcome from the
// return context, the first takes the callback's own record S. Both are
// values of the result type, so the function settles with either.
type Json = null | boolean | number | string | readonly Json[] | { [key: string]: Json };
interface Outcome {
  text: string;
  structured?: Json;
}
interface Flat {
  text: string;
  structured?: string | number;
}
type Summary = string | { kind: "image"; note: string };

function summarize(text: string): Summary {
  return text.length > 3 ? { kind: "image", note: text } : text;
}

async function spreadThen(text: string): Promise<Outcome> {
  return Promise.resolve({ text }).then((r) => ({ ...r, structured: summarize(r.text) }));
}
async function fieldsThen(text: string): Promise<Outcome> {
  return Promise.resolve({ text }).then((r) => ({ text: r.text, structured: summarize(r.text) }));
}
async function spreadAwait(text: string): Promise<Outcome> {
  const r = await Promise.resolve({ text });
  return { ...r, structured: summarize(r.text) };
}
async function spreadThenString(text: string): Promise<Outcome> {
  return Promise.resolve({ text }).then((r) => ({ ...r, structured: r.text }));
}
async function spreadThenFlat(text: string): Promise<Flat> {
  return Promise.resolve({ text }).then((r) => ({
    ...r,
    structured: r.text.length > 3 ? r.text : r.text.length,
  }));
}
function spreadThenSync(text: string): Promise<Outcome> {
  return Promise.resolve({ text }).then((r) => ({ ...r, structured: summarize(r.text) }));
}
async function spreadThenAnnotated(text: string): Promise<Outcome> {
  return Promise.resolve({ text }).then((r): Outcome => ({ ...r, structured: summarize(r.text) }));
}
// The same value through an await: the operand has the same union type.
async function awaitedThen(text: string): Promise<Flat> {
  return await Promise.resolve({ text }).then((r) => ({ ...r, structured: r.text }));
}
async function awaitedInto(text: string): Promise<Flat> {
  const flat: Flat = await Promise.resolve({ text }).then((r) => ({ ...r, structured: r.text }));
  return flat;
}
// A chain of several steps, a chain that passes the record on, and a pick
// from Promise.all.
async function chained(text: string): Promise<Flat> {
  return Promise.resolve(text)
    .then((t) => t + "!")
    .then((t) => ({ text: t, structured: t.length }));
}
async function passedOn(text: string): Promise<Flat> {
  return Promise.resolve({ text })
    .then((r) => ({ ...r, structured: r.text }))
    .then((r) => r);
}
async function picked(text: string): Promise<Flat> {
  return Promise.all([Promise.resolve(text), Promise.resolve(text.length)]).then((all) => ({
    text: all[0],
    structured: all[1],
  }));
}
// The record declares optional members the callback's record lacks.
interface Wide {
  text: string;
  count?: number;
  tags?: string[];
}
async function fewer(text: string): Promise<Wide> {
  return Promise.resolve(text).then((t) => ({ text: t }));
}
// The callback's record has a member the result does not declare.
interface Narrow {
  text: string;
}
async function extra(text: string): Promise<Narrow> {
  return Promise.resolve(text).then((t) => ({ text: t, size: t.length }));
}
// A member of the result is the wider record.
interface Holder {
  tag: string;
  inner: Flat;
}
async function nested(text: string): Promise<Holder> {
  return Promise.resolve(text).then((t) => ({ tag: "t", inner: { text: t, structured: t } }));
}
// The result is the record or undefined.
async function orNothing(text: string): Promise<Flat | undefined> {
  return Promise.resolve(text).then((t) => ({ text: t, structured: t }));
}

function describe(value: Outcome | Flat): string {
  return `${value.text} ${JSON.stringify(value.structured ?? null)} ${"structured" in value}`;
}

async function show(name: string, run: (text: string) => Promise<Outcome | Flat>): Promise<void> {
  for (const text of ["ab", "abcdef"]) {
    try {
      const outcome = await run(text);
      console.log(name, describe(outcome), JSON.stringify(outcome));
    } catch (error) {
      console.log(name, "failed:", (error as Error).message);
    }
  }
}

async function main(): Promise<void> {
  await show("spread then", spreadThen);
  await show("fields then", fieldsThen);
  await show("spread await", spreadAwait);
  await show("spread then string", spreadThenString);
  await show("spread then flat", spreadThenFlat);
  await show("spread then sync", spreadThenSync);
  await show("spread then annotated", spreadThenAnnotated);
  await show("awaited then", awaitedThen);
  await show("awaited into", awaitedInto);
  await show("chained", chained);
  await show("passed on", passedOn);
  await show("picked", picked);
  const wide = await fewer("ab");
  console.log("fewer", wide.text, wide.count, wide.tags, "count" in wide, JSON.stringify(wide));
  const narrow = await extra("abc");
  console.log("extra", narrow.text);
  const holder = await nested("ab");
  console.log("nested", holder.tag, describe(holder.inner));
  const maybe = await orNothing("ab");
  console.log("or nothing", maybe === undefined ? "none" : describe(maybe));
}
main();
