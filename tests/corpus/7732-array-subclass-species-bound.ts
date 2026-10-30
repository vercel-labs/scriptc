// map, filter and flatMap read the receiver's length before the species
// constructor runs: elements the constructor appends to the receiver are
// not visited.
let watched: Growing | null = null;

class Growing extends Array<number> {
  constructor(...args: number[]) {
    super(...args);
    if (watched !== null) watched.push(watched.length * 100);
  }
}

const source = Growing.from([1, 2, 3]);
watched = source;
const visits: number[] = [];
const doubled = source.map((value) => {
  visits.push(value);
  return value * 2;
});
console.log(doubled.join(","), visits.join(","), source.join(","));
visits.length = 0;
const kept = source.filter((value) => {
  visits.push(value);
  return value > 1;
});
console.log(kept.join(","), visits.join(","), source.length);
visits.length = 0;
const spread = source.flatMap((value) => {
  visits.push(value);
  return [value];
});
console.log(spread.length, visits.length, source.length);
