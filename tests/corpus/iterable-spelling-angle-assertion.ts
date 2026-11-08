// @transform-types
// The name in "x is not iterable" is the source text of the iterated
// expression without the wrappers JavaScript never sees: an angle-bracket
// assertion is one of them, as `as` is.
const five: unknown = process.argv.length > 99 ? [1] : 5;
const holder = { inner: { list: five } };

const attempt = (go: () => void): void => {
  try {
    go();
  } catch (error) {
    console.log((error as Error).name, (error as Error).message);
  }
};

attempt(() => {
  for (const x of <any>five) console.log(x);
});
attempt(() => {
  for (const x of five as any) console.log(x);
});
attempt(() => {
  for (const x of <any>holder.inner.list) console.log(x);
});
attempt(() => {
  for (const x of holder.inner.list as any) console.log(x);
});
attempt(() => {
  for (const x of <any>(<unknown>five)) console.log(x);
});
attempt(() => {
  console.log([...(<any>holder.inner.list)]);
});
attempt(() => {
  console.log([...(holder.inner.list as any)]);
});
