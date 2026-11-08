// @requires-libnode
// A package that only a literal `import()` inside a function reaches, its
// export taken by destructuring. Nothing imports the package statically, so
// the program does not compile it: it runs in a Node island and is loaded at
// the first call, not at start. The package it requires loads with it, in
// Node's order, and both are evaluated once however often the function runs.
async function receipt(cents: number): Promise<string> {
  const { money } = await import("ledger-format");
  return money(cents);
}

console.log("nothing is loaded yet");
console.log(await receipt(123456789));
console.log(await receipt(-250));
