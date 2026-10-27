// The ambient String, Number and Boolean as `.then` handlers over a
// number or boolean settled value convert it, as calling them would.
async function flag(value: boolean): Promise<boolean> {
  return value;
}

async function main(): Promise<void> {
  const a = await flag(true).then(String);
  const b = await flag(false)
    .then(String)
    .catch(() => "unknown");
  const n = await flag(true).then(Number);
  const s = await Promise.resolve(1.5).then(String);
  const t = await Promise.resolve(0).then(Boolean);
  const u = await Promise.resolve(-0).then(String);
  console.log(a, b, n + 1, s, t, u);
}

main();
