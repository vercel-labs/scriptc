// A JavaScript package whose export is a function with methods, built by a
// class whose constructor answers that function instead of the instance
// (it keeps the function on `this` while it attaches the methods). The
// declarations describe it as a function merged with a namespace, and a
// call answers a value of the same type. The program calls it, calls
// methods of the export and of a call's result, keeps a result in typed
// places and looks at it the ways untyped code can.
import palette from "tone-kit";

function paint({ tone = palette("amber").dark(), finish = "matt" }: { tone?: string; finish?: string } = {}): string {
  return `${tone} ${finish}`;
}
console.log("default parameter", paint(), paint({ tone: "plain", finish: "gloss" }));

console.log("method of a result", palette("teal").light(), palette("teal").light(300));
console.log("method of the export", palette.dark(), palette.label(), palette.both().length, palette.steps() + 1);

const amber = palette("amber");
console.log("stored", amber.label(), amber.light(), amber.both().join("|"));
console.log("result called", palette("amber")("rose").label(), palette("a")("b")("c").dark());
console.log("options", palette({ name: "moss" }).label(), palette({ name: "moss", steps: 5 }).steps(), palette().label());

function describe(p: typeof palette): string {
  return p.label() + ":" + p.dark();
}
const kept: typeof palette = palette("iron");
console.log("typed places", describe(palette("zinc")), describe(palette), kept.label(), kept("lime").label());

const many: (typeof palette)[] = [palette("a"), palette("b")];
console.log("in an array", many.map((p) => p.label()).join(","));

const dark = palette("plum").dark;
console.log("method as a value", dark());

const one = palette("fern");
console.log("identity", one === one, palette("fern") === palette("fern"), palette === palette);
console.log("what it is", typeof palette, typeof palette("fern"), typeof palette("fern").dark, Object.keys(palette("fern")).join(","));
