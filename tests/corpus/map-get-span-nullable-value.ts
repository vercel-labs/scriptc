// Map.get of a nullable reference value under a split-view key. A `for...of`
// over `text.split(",")` yields string spans, and the lookup borrows the
// span instead of materializing a key string; the stored `Box | null` value
// widens into `Box | null | undefined`, so the read asks whether the key is
// present before it reads the value (a stored null is a hit, a miss is
// undefined). The runtime's span lookups include that presence test.
// Node.js runs the same program unchanged.
class Box {
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
  get(): number {
    return this.n;
  }
}

function main(): void {
  const table = new Map<string, Box | null>();
  table.set("a", new Box(1));
  table.set("b", null);
  table.set("c", new Box(3));
  const text = "a,b,c,zz,a";
  const seen: string[] = [];
  let total = 0;
  for (const piece of text.split(",")) {
    const box = table.get(piece);
    if (box !== undefined && box !== null) {
      total += box.get();
      seen.push("box:" + piece);
    } else if (box === null) {
      total += 100;
      seen.push("null:" + piece);
    } else {
      total += 1000;
      seen.push("miss:" + piece);
    }
  }
  console.log(seen.join(" "));
  console.log("total " + total);
  console.log("has-b " + (table.get("b") === null));
}
main();
