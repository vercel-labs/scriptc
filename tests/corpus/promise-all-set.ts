// Promise.all over a Set: Node iterates the set, so the values array keeps
// insertion order, duplicates collapse when the same promise is added twice,
// an empty set resolves on the next turn, and a Set<Promise<void>> needs no
// values array. Compared against Node entry for entry.
const set = new Set<Promise<string>>();
const slow = new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 1));
set.add(Promise.resolve("first"));
set.add(slow);
set.add(Promise.resolve("third"));
console.log(JSON.stringify(await Promise.all(set)));

const repeated = new Set<Promise<number>>();
const shared = Promise.resolve(7);
repeated.add(shared);
repeated.add(shared);
console.log(JSON.stringify(await Promise.all(repeated)));

const voids = new Set<Promise<void>>();
voids.add(Promise.resolve());
console.log("void values:", (await Promise.all(voids)).length);

const empty = new Set<Promise<string>>();
console.log(JSON.stringify(await Promise.all(empty)));

const rejected = new Set<Promise<string>>();
rejected.add(Promise.resolve("ok"));
rejected.add(Promise.reject(new Error("boom")));
try {
  await Promise.all(rejected);
} catch (error) {
  console.log("rejected:", (error as Error).message);
}
