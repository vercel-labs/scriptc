// process.permission exists only under Node's --permission flag; a compiled
// binary runs without a permission model, so the member is undefined exactly
// as it is in Node without the flag.
console.log(process.permission === undefined, typeof process.permission);

try {
  console.log(process.permission!.has("fs"));
} catch (err) {
  const e = err as { name: string; message: string };
  console.log(`${e.name}: ${e.message}`);
}

console.log(process.permission?.has("fs.read"));
