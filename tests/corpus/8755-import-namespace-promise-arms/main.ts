// A conditional `import()` of two modules settles ONE of two namespace
// objects. A namespace has no union tag — the value is the module's
// namespace object either way — so the joint promise payload is the
// checked-dynamic value, and `then`/`await` read it like any other object.
// (A union of module namespaces has no representation; the pi providers
// build exactly this shape from a per-file registry.)
function pick(flag: boolean) {
  return flag ? import("./left.ts") : import("./right.ts");
}

async function main(): Promise<void> {
  const left = await pick(true);
  console.log(left.label, left.value);
  const right = await pick(false);
  console.log(right.label, right.value);
  await pick(false).then((m) => console.log("then", m.label, m.value));
  const both = await Promise.all([pick(true), pick(false)]);
  console.log(both.map((m) => m.label).join(","));
}

main();
