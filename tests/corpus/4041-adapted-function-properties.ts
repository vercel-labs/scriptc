// A function seen through a wider signature is the same function object:
// its name, length and own properties are shared with the original, and
// a dynamic value converted back to a typed slot keeps its identity.
function scale(x: number): number {
  return x * 2;
}
const wide: (x: number, i: number) => number = scale;
const viaWide: any = wide;
const viaOriginal: any = scale;
console.log(viaWide === viaOriginal, viaWide.name, viaWide.length, viaOriginal.length);
Object.defineProperty(wide, "tag", { value: "shared" });
console.log(viaOriginal.tag, viaWide.tag);

const boxed: unknown = scale;
const back = boxed as (x: number, i: number) => number;
console.log(back === scale, back(4, 0), boxed === wide);
const loose: any = scale;
const typed: (x: string) => number = loose;
console.log(typed === loose, (typed as unknown) === boxed);

function other(x: number): number {
  return x;
}
const otherWide: (x: number, i: number) => number = other;
const viaOther: any = otherWide;
console.log(viaOther === viaWide, viaOther.tag, viaOther.name, viaOther.length);
