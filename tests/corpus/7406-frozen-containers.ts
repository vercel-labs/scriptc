// Object.freeze of arrays, Maps and Sets that other references still hold.
// A frozen array refuses every write through any reference with Node's
// TypeError for the operation's first write (this module is strict mode
// code). A frozen Map or Set only stops being extensible: its entries stay
// writable, and Object.isFrozen, isSealed and isExtensible report it.
export {};

function report(e: unknown): void {
  console.log((e as Error).name + ": " + (e as Error).message);
}

function freezeUnknown(value: unknown): unknown {
  return Object.freeze(value);
}

function writeAny(value: any): void {
  value[0] = 7;
}

function pushAny(value: any): void {
  value.push(8);
}

function integrity(value: unknown): string {
  return [Object.isFrozen(value), Object.isSealed(value), Object.isExtensible(value)].join(" ");
}

function arrays(): void {
  const a: number[] = [1, 2, 3];
  const alias = a;
  console.log(Object.isFrozen(a), integrity(a));
  Object.freeze(alias);
  console.log(Object.isFrozen(a), integrity(a));
  try { a[0] = 9; } catch (e) { report(e); }
  try { a[5] = 9; } catch (e) { report(e); }
  try { a.length = 0; } catch (e) { report(e); }
  try { a.push(4); } catch (e) { report(e); }
  try { a.pop(); } catch (e) { report(e); }
  try { a.shift(); } catch (e) { report(e); }
  try { a.unshift(0); } catch (e) { report(e); }
  try { a.splice(0, 1); } catch (e) { report(e); }
  try { a.splice(1, 0, 7); } catch (e) { report(e); }
  try { a.reverse(); } catch (e) { report(e); }
  try { a.sort(); } catch (e) { report(e); }
  try { a.fill(0, 1); } catch (e) { report(e); }
  try { a.copyWithin(1, 0); } catch (e) { report(e); }
  console.log(a.join(), a.length);

  const one: string[] = ["x"];
  Object.freeze(one);
  console.log(one.reverse().join(), one.sort().join(), one.copyWithin(0, 1).join());
  try { one.splice(0, 1); } catch (e) { report(e); }
  try { one.shift(); } catch (e) { report(e); }
  const none: string[] = [];
  Object.freeze(none);
  console.log(none.reverse().length, none.fill("y").length);
  try { none.pop(); } catch (e) { report(e); }
  try { none.splice(0, 0, "z"); } catch (e) { report(e); }

  let calls = 0;
  const byValue = (x: number, y: number): number => {
    calls++;
    return x - y;
  };
  const unsorted: number[] = [3, 1, 2];
  Object.freeze(unsorted);
  try { unsorted.sort(byValue); } catch (e) { report(e); }
  const single: number[] = [5];
  Object.freeze(single);
  console.log(unsorted.join(), calls > 0, single.sort(byValue).join());

  // A comparator that freezes the array stops the sort's write-back.
  const freezing: number[] = [3, 1, 2];
  try {
    freezing.sort((x, y) => {
      Object.freeze(freezing);
      return x - y;
    });
  } catch (e) { report(e); }
  console.log(freezing.join(), Object.isFrozen(freezing));

  const open: number[] = [4, 5];
  open.push(6);
  open[0] = 1;
  console.log(open.join(), Object.isFrozen(open));
}

function throughUnknown(): void {
  const a: number[] = [1, 2];
  console.log(integrity(a));
  const back = freezeUnknown(a);
  console.log(back === a, Object.isFrozen(a), integrity(a));
  try { a.push(3); } catch (e) { report(e); }
  try { a[1] = 5; } catch (e) { report(e); }
  try { writeAny(a); } catch (e) { report(e); }
  try { pushAny(a); } catch (e) { report(e); }
  console.log(a.join());

  const rows: number[][] = [[1], [2]];
  freezeUnknown(rows[1]);
  rows[0]!.push(10);
  try { rows[1]!.push(20); } catch (e) { report(e); }
  console.log(JSON.stringify(rows), Object.isFrozen(rows), Object.isFrozen(rows[1]));
}

function collections(): void {
  const m = new Map<string, number>([["x", 1]]);
  console.log(integrity(m));
  const frozen = Object.freeze(m);
  m.set("y", 2);
  m.delete("x");
  console.log(frozen === m, Object.isFrozen(m), Object.isSealed(m), Object.isExtensible(m), m.size);
  const s = new Set<number>([1]);
  freezeUnknown(s);
  s.add(2);
  console.log(integrity(s), s.size);
  const sealed = new Set<string>();
  Object.seal(sealed);
  const fresh = new Map<number, number>();
  Object.preventExtensions(fresh);
  console.log(Object.isFrozen(sealed), Object.isExtensible(fresh), integrity(new Map()));
}

function lifetimes(): void {
  const kept: string[][] = [];
  for (let round = 0; round < 3; round++) {
    const row = ["r" + round, "s" + round];
    if (round !== 1) Object.freeze(row);
    kept.push(row);
  }
  for (const row of kept) {
    try { row[0] = "changed"; } catch (e) { console.log(row[1], (e as Error).message); }
  }
  console.log(JSON.stringify(kept));
  kept.length = 0;
  console.log(kept.length);
}

arrays();
throughUnknown();
collections();
lifetimes();
