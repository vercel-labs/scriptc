// The ES2023 non-mutating Array copying methods. Node 24 is the oracle for
// index coercion, insertion/removal, evaluation order, and RangeError text.

const source = [1, 2, 3, 4];
console.log(source.toReversed().join(","), source.join(","));

console.log(source.toSpliced(1, 2, 8, 9).join(","));
console.log(source.toSpliced(-2, 1, 7).join(","));
console.log(source.toSpliced(2).join(","));
console.log(source.toSpliced(1, undefined).join(","));
const missingDeleteCount: undefined = undefined;
console.log(source.toSpliced(1, void 0).join(","));
console.log(source.toSpliced(1, missingDeleteCount).join(","));
const deleteOrder: string[] = [];
const effectDefault = source.toSpliced(1, (() => {
  deleteOrder.push("call");
  return undefined;
})());
const voidEffectDefault = source.toSpliced(
  1,
  void deleteOrder.push("void"),
);
const assertedVoidEffectDefault = source.toSpliced(
  1,
  (void deleteOrder.push("asserted")) as undefined,
);
const nestedVoidEffectDefault = source.toSpliced(
  1,
  void (void deleteOrder.push("nested")),
);
console.log(
  effectDefault.join(","),
  voidEffectDefault.join(","),
  assertedVoidEffectDefault.join(","),
  nestedVoidEffectDefault.join(","),
  deleteOrder.join(","),
);
console.log(source.toSpliced(NaN, 0, 6).join(","));
console.log(source.join(","));

console.log(source.with(1, 8).join(","));
console.log(source.with(-1, 9).join(","));
console.log(source.with(1.9, 7).join(","));
console.log(source.with(NaN, 6).join(","));
console.log(source.join(","));

for (const index of [4, -5, Infinity]) {
  try {
    source.with(index, 0);
  } catch (err) {
    const e = err as Error;
    console.log(e.name, e.message);
  }
}

const order: string[] = [];
const evaluated = (() => {
  order.push("receiver");
  return [1, 2, 3];
})().with((() => {
  order.push("index");
  return 1;
})(), (() => {
  order.push("value");
  return 5;
})());
console.log(evaluated.join(","), order.join(","));

const records = [{ n: 1 }, { n: 2 }];
const copied = records.toReversed();
copied[0]!.n = 20;
console.log(records[1]!.n, copied[1] === records[0]);

const inserted = { n: 3 };
const splicedRecords = records.toSpliced(1, 0, inserted);
const replacement = { n: 4 };
const withRecord = records.with(0, replacement);
console.log(
  splicedRecords.length,
  splicedRecords[0] === records[0],
  splicedRecords[1] === inserted,
  withRecord[0] === replacement,
  withRecord[1] === records[1],
);
