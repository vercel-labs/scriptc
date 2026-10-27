// JSON.stringify of a typed array runs the toJSON of a foreign element
// (an object written through an unknown[] view) with the element's index
// as its key, as Node does, including when the hook grows, truncates or
// replaces the arrays holding it. A hook or getter that throws stops the
// stringify with its exception.
const nums: number[] = [1, 2, 3];
const view: unknown[] = nums;
view[1] = {
  toJSON(key: string) {
    return `v${key}`;
  },
};
view[2] = { toJSON: 5 };
console.log(JSON.stringify(nums), JSON.stringify(view));

const words: string[] = ["a", "b"];
const wordsView: unknown[] = words;
wordsView[0] = { toJSON: () => undefined };
wordsView[1] = { toJSON: () => ({ nested: [1, 2] }) };
console.log(JSON.stringify(words), JSON.stringify({ words }));

// The hook grows the parent past its storage and then truncates it.
const outer: number[][] = [[1, 2], [3], [4, 5, 6]];
const innerView: unknown[] = outer[1]!;
let calls = 0;
innerView[1] = {
  toJSON() {
    calls++;
    for (let i = 0; i < 300; i++) outer.push([i, i + 1]);
    if (calls === 1) outer.length = 2;
    return "hooked";
  },
};
console.log(JSON.stringify(outer), outer.length, calls);

// The hook replaces the parent's elements two levels up.
const deep: number[][][] = [[[1], [2]], [[3]]];
const deepView: unknown[] = deep[0]![1]!;
deepView[0] = {
  toJSON() {
    for (let i = 0; i < 200; i++) deep.push([[i]]);
    deep[0] = [];
    return 9;
  },
};
console.log(JSON.stringify(deep).length, deep.length);

// A throwing hook or getter stops the stringify.
const thrown: number[] = [1, 2];
const thrownView: unknown[] = thrown;
thrownView[1] = {
  toJSON() {
    throw new Error("from toJSON");
  },
};
try {
  console.log(JSON.stringify(thrown));
} catch (error) {
  console.log("caught", (error as Error).message);
}
thrownView[1] = {
  get a() {
    throw new Error("from getter");
  },
};
try {
  console.log(JSON.stringify(thrown));
} catch (error) {
  console.log("caught", (error as Error).message);
}
const after: unknown[] = [1, { b: 2 }];
console.log(JSON.stringify(after));
