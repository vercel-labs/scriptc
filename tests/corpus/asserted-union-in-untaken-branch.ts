// A generic function whose second parameter is a conditional type of the
// first, with each branch asserting the parameter to the type its test
// implies. In the instance for the other branch the assertion is between
// types with no conversion; that branch does not run for that instance, and
// the assertion is checked there like a cast of an unknown value.

type Size = "letter" | "parcel" | "freight";

interface Letter {
  kind: "letter";
  to: string;
  stamp: () => string;
}
interface Parcel {
  kind: "parcel";
  to: string;
  grams: number;
  stamp: () => string;
}
interface Freight {
  goods: string;
  tons: number;
  stamp: string;
  repeats?: string;
}
type Item<S extends Size> = S extends "freight" ? Freight : Letter | Parcel;

function freightLine(item: Freight): string {
  return `freight ${item.goods} ${item.tons}t ${item.stamp}${item.repeats ? " " + item.repeats : ""}`;
}
function postLine(size: Size, item: Letter | Parcel): string {
  return `${size} ${item.kind} to ${item.to}${item.kind === "parcel" ? " " + item.grams + "g" : ""} ${item.stamp()}`;
}

function byTest<S extends Size>(size: S, item: Item<S>): string {
  if (size === "freight") {
    return freightLine(item as Freight);
  }
  return postLine(size, item as Letter | Parcel);
}

function byBinding<S extends Size>(size: S, item: Item<S>): string {
  if (size === "freight") {
    const freight = item as Freight;
    return freightLine(freight);
  }
  const post = item as Letter | Parcel;
  return postLine(size, post);
}

function bySwitch<S extends Size>(size: S, item: Item<S>): string {
  switch (size) {
    case "freight":
      return freightLine(item as Freight);
    default:
      return postLine(size, item as Letter | Parcel);
  }
}

function byConditional<S extends Size>(size: S, item: Item<S>): string {
  return size === "freight" ? freightLine(item as Freight) : postLine(size, item as Letter | Parcel);
}

const letter: Letter = { kind: "letter", to: "Oslo", stamp: () => "blue" };
const parcel: Parcel = { kind: "parcel", to: "Lima", grams: 800, stamp: () => "red" };
const sand: Freight = { goods: "sand", tons: 12, stamp: "bulk" };
const salt: Freight = { goods: "salt", tons: 2, stamp: "bulk", repeats: "weekly" };

console.log(byTest("letter", letter));
console.log(byTest("parcel", parcel));
console.log(byTest("freight", sand));
console.log(byTest("freight", salt));
console.log(byBinding("letter", letter));
console.log(byBinding("parcel", parcel));
console.log(byBinding("freight", sand));
console.log(byBinding("freight", salt));
console.log(bySwitch("letter", letter));
console.log(bySwitch("parcel", parcel));
console.log(bySwitch("freight", sand));
console.log(bySwitch("freight", salt));
console.log(byConditional("letter", letter));
console.log(byConditional("parcel", parcel));
console.log(byConditional("freight", sand));
console.log(byConditional("freight", salt));
