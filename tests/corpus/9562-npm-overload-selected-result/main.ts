// JavaScript packages whose declarations give one function several
// signatures: a text gives a number, a number gives a text. The function's
// body returns every one of those, so only the signature the call selected
// says which the caller holds. The selected result is used as what it is
// declared: in arithmetic, comparisons, typed parameters and results, with
// string methods, as an array and as a record. One package is typed by a
// separate declaration package, the other by its own declaration file.
import weigh from "weigh";
import { measured, pick, read, ruler, single, spans } from "gauge";

function load(base: number, extra?: string): number {
  const light = base - weigh("3kg");
  return light + weigh(extra ?? "250 g");
}
console.log("arithmetic", load(10000), load(10000, "2t"), 5 + weigh("20g") * 2);

const kept = weigh("4kg");
const doubled: number = kept * 2 + 1;
console.log("stored", kept, doubled, typeof kept);
console.log("compared", weigh("3kg") > 2500, weigh("1g") === 1, weigh("2kg") <= 1999);

function twice(amount: number): number {
  return amount * 2;
}
function gramsOf(text: string): number {
  return weigh(text);
}
console.log("parameter and result", twice(weigh("3kg")), gramsOf("4kg") + 1);

const texts: string[] = ["1kg", "20 g", "3t"];
let total = 0;
for (const text of texts) total += weigh(text);
console.log("loop", total, Math.max(weigh("1kg"), weigh("2kg")));

console.log("text result", weigh(1500).toUpperCase(), weigh(20).length, "w=" + weigh(2500, { long: true }));
const back: number = weigh(weigh(2500));
console.log("both signatures", back);

// Named exports and a method, typed by the package's own declaration file.
console.log("named", read("3cm") - 5, read(2500).length, 1 + read("2m") / 4);
console.log("method", ruler.read("4cm") * 2, ruler.read(30).toUpperCase(), ruler.name);

// One signature: nothing was selected, so the body's result stays.
const lone = single("7cm");
console.log("single", lone, single("nothing") === undefined);

// A declared result that is itself a union, an array and a record.
const some = pick("3cm");
console.log("sub-union", some === undefined ? -1 : some + 1, pick("nothing") ?? 7, pick(40).length);
const both = spans("2cm");
console.log("array", both[0], both.length, both.map((mm) => mm / 10).join(","), spans(2500) + "!");
const one = measured("2m");
console.log("record", one.mm + 1, one.text.toUpperCase(), measured(15).length);

// A value passed straight to a consumer that takes anything is not converted.
console.log("printed", weigh("3kg"), read("1m"), weigh("heavy"), read("far"));
