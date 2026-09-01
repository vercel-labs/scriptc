// Promise.all lowers over one promise type (any Promise<T>[] expression);
// plain-value tuple literals still fence, non-array arguments fence on their
// shape, and allSettled/any stay fenced.
async function plainValues(): Promise<void> {
  const pair = await Promise.all(["s", 1] as const);
  console.log(pair.length);
}
async function settled(): Promise<void> {
  const one = new Promise<number>((resolve) => resolve(1));
  await Promise.allSettled([one]);
}
plainValues();
settled();
