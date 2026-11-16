class Bag extends Array {}

const sides = ["top", "right", "bottom", "left"];
const kept = [
  "color",
  ...sides.flatMap((side) => [`padding-${side}`, `border-${side}-width`]),
  ...["top-left", "top-right"].map((corner) => `border-${corner}-radius`),
];

export function bagTotal() {
  return kept.length + new Bag(3).length;
}

console.log("dep", kept.length, kept.join(","));
