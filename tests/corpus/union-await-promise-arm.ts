// Awaiting a union whose promise arm settles a union
// (`Promise<A | B> | undefined`): the promise arm is awaited, and a
// non-promise arm answers its own value after one microtask turn.
function maybe(flag: boolean): Promise<string | null> | undefined {
  if (!flag) return undefined;
  return Promise.resolve(flag ? "value" : null);
}

async function main(): Promise<void> {
  const absent = await maybe(false);
  console.log(String(absent));
  const settled = await maybe(true);
  console.log(String(settled));
  const nil = await maybe(true);
  console.log(nil === null);

  // Awaiting a non-promise arm takes exactly one microtask turn.
  const order: string[] = [];
  Promise.resolve().then(() => order.push("microtask"));
  const hopped = await maybe(false);
  order.push(`after:${String(hopped)}`);
  console.log(order.join(","));
}
main();
