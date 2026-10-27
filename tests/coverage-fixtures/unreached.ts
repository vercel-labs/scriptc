// A program whose ENTRY PATH is fully static while an unused corner is
// not: builds succeed (unreached bodies never lower), and the report
// shows the corner's blockers in the dim "in unreached code" group.
function used(n: number): number {
  return n + 1;
}

class Bag {
  size = 0;
}

// Never called: the class-instance for-in and the labeled jump into a
// desugared loop can't fail a build.
function unusedCorner(bag: Bag, pairs: Map<string, number>): void {
  for (const k in bag) {
    console.log(k);
  }
  outer: for (const [k, v] of pairs) {
    if (v > 0) break outer;
    console.log(k);
  }
}

console.log(used(41));
