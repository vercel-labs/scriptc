// Array.fromAsync over a Set and over a string. A Set iterates its live
// entries through the async-from-sync protocol (each value awaited, two
// microtask hops per value), and a string iterates its code points.

async function main(): Promise<void> {
  console.log((await Array.fromAsync(new Set([1, 2, 3]))).join(","));

  const live = new Set([1, 2, 3]);
  const order: string[] = [];
  const pending = Array.fromAsync(live, (value) => {
    order.push("map" + value);
    if (value === 1) live.add(4);
    if (value === 2) live.delete(3);
    return value;
  });
  order.push("sync");
  console.log((await pending).join(","), order.join("|"));

  const empty = new Set<number>();
  console.log((await Array.fromAsync(empty)).length);

  console.log((await Array.fromAsync("a\u{1F600}b")).join(","));
  console.log((await Array.fromAsync("xyz", (c, i) => c + i)).join(","));

  const words = new Set(["one", "two"]);
  console.log((await Array.fromAsync(words, (word) => word.length)).join(","));

  const rows = new Set([{ id: 1 }, { id: 2 }]);
  console.log(JSON.stringify(await Array.fromAsync(rows)));

  const inFlight = Array.fromAsync(new Set<number>());
  console.log(Array.isArray(inFlight), typeof inFlight.then);

  try {
    await Array.fromAsync(new Set([1, 2]), (value) => {
      if (value === 2) throw new Error("mapping failed");
      return value;
    });
    console.log("no throw");
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}

main();
