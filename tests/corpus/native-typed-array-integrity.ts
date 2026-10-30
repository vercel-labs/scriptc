"use strict";

function attempt(label: string, write: () => void): void {
  try {
    write();
    console.log(label, "allowed");
  } catch (error) {
    console.log(label, (error as Error).name);
  }
}

for (let count = 0; count <= 2; count++) {
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(i + 1);
  const alias = values;
  console.log("array", count, Object.freeze(values) === alias, Object.isFrozen(alias));
  attempt("push", () => { alias.push(); });
  attempt("unshift", () => { alias.unshift(); });
  attempt("pop", () => { alias.pop(); });
  attempt("shift", () => { alias.shift(); });
  attempt("splice", () => { alias.splice(0, 0); });
  attempt("reverse", () => { alias.reverse(); });
  attempt("sort", () => { alias.sort(); });
  attempt("fill no-op", () => { alias.fill(9, 0, 0); });
  attempt("copy no-op", () => { alias.copyWithin(0, 0, 0); });
  attempt("length", () => { alias.length = alias.length; });
  attempt("index", () => { alias[0] = 9; });
  console.log("contents", alias.join(","));
}

const sorting = [3, 2, 1];
attempt("freeze in comparator", () => {
  sorting.sort((a, b) => {
    Object.freeze(sorting);
    return a - b;
  });
});
console.log("sorting", sorting.join(","), Object.isFrozen(sorting));

const singletonHole: number[] = [];
singletonHole.length = 1;
singletonHole.sort((a, b) => a - b);
const singletonCopy = singletonHole.toSorted((a, b) => a - b);
console.log("singleton hole", Object.hasOwn(singletonHole, 0),
  Object.hasOwn(singletonCopy, 0), singletonCopy[0] === undefined);

for (const sorted of [false, true]) {
  const values = sorted ? [1, 2] : [2, 1];
  Object.freeze(values);
  attempt("frozen default sort " + sorted, () => { values.sort(); });
  attempt("frozen keyed sort " + sorted, () => { values.sort((a, b) => a - b); });
  console.log("fresh sorted copy", values.toSorted().join(","),
    values.toSorted((a, b) => a - b).join(","), values.join(","));
}

const sealed = [1, 2];
Object.seal(sealed);
sealed[0] = 3;
attempt("sealed grow", () => { sealed.push(4); });
attempt("sealed shrink", () => { sealed.length = 0; });
console.log("sealed", sealed.join(","), sealed.length, Object.isSealed(sealed), Object.isFrozen(sealed));

const fixed = [1, 2];
Object.preventExtensions(fixed);
fixed.pop();
attempt("fixed grow", () => { fixed.push(3); });
console.log("fixed", fixed.join(","), Object.isExtensible(fixed));

function checkedPop(value: any): any { return value.pop(); }
for (let level = 0; level < 3; level++) {
  const words = ["first", "last"];
  if (level === 0) Object.preventExtensions(words);
  else if (level === 1) Object.seal(words);
  else Object.freeze(words);
  attempt("checked pop " + level, () => { console.log("checked result", checkedPop(words)); });
  console.log("checked contents", words.length, words.join(","));
}
const emptyWords: string[] = [];
Object.freeze(emptyWords);
attempt("checked empty pop", () => { checkedPop(emptyWords); });

const variants: (number | string)[] = [1, "last", 3];
Object.seal(variants);
attempt("union discarded shift", () => { variants.shift(); });
console.log("union partial contents", variants.join(","));
attempt("union returned pop", () => { console.log("union result", variants.pop()); });

for (let level = 0; level < 3; level++) {
  const words = ["first", "middle", "last"];
  if (level === 0) Object.preventExtensions(words);
  else if (level === 1) Object.seal(words);
  else Object.freeze(words);
  attempt("discarded splice " + level, () => { words.splice(0, 2, "inserted"); });
  console.log("splice partial contents", words.length, words.join(","));
  attempt("returned splice " + level, () => {
    console.log("splice result", words.splice(1, 1, "replacement").join(","));
  });
  console.log("splice final contents", words.length, words.join(","));
}
// @ts-expect-error JavaScript permits zero-argument splice.
attempt("empty discarded splice", () => { emptyWords.splice(); });
// @ts-expect-error JavaScript permits zero-argument splice.
attempt("empty returned splice", () => { console.log(emptyWords.splice().length); });

const extensionCases: number[] = [0, 1, 2, 64, 65];
for (const count of extensionCases) {
  const items: string[] = [];
  for (let i = 0; i < count; i++) items.push(String(i));
  for (let level = 0; level < 3; level++) {
    const target = ["first", "last"];
    target.length = 4;
    if (level === 0) Object.preventExtensions(target);
    else if (level === 1) Object.seal(target);
    else Object.freeze(target);
    attempt("push " + level + "/" + count, () => { console.log("push length", target.push(...items)); });
    attempt("unshift " + level + "/" + count, () => { console.log("unshift length", target.unshift(...items)); });
    console.log("extension contents", target.length, target.join(","));
  }
}
const sourceWords: string[] = [];
const optionalWords = ["kept"];
Object.freeze(optionalWords);
attempt("optional push", () => { optionalWords.push(sourceWords[2]); });
attempt("optional unshift", () => { optionalWords.unshift(sourceWords[2]); });
console.log("optional contents", optionalWords.join(","));

function appendSlot(words: string[], index: number, suffix: () => string): void {
  words[index] = words[index] + suffix();
}
const frozenSlot = ["kept"];
Object.freeze(frozenSlot);
attempt("self concat refusal", () => {
  appendSlot(frozenSlot, 0, () => { console.log("suffix evaluated"); return " changed"; });
  console.log("after forbidden concat");
});
console.log("self concat contents", frozenSlot[0]);
attempt("undefined store refusal", () => {
  frozenSlot[0] = sourceWords[0];
  console.log("after forbidden undefined");
});
attempt("delete present refusal", () => {
  delete frozenSlot[0];
  console.log("after forbidden delete");
});
attempt("delete missing allowed", () => { delete frozenSlot[3]; });
