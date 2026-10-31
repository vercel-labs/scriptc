// Array producers whose callback answers `undefined`: the result is an
// `undefined[]`, whose elements are PRESENT undefined values (JSON prints
// them as null, `in` sees them), and the mapper still runs once per index.

type PendingQuery = {
  palette: undefined[];
  timer: number | undefined;
};

function build(n: number): PendingQuery {
  return {
    palette: Array.from({ length: n }, () => undefined),
    timer: undefined,
  };
}

const query = build(3);
console.log(query.palette.length);
console.log(query.palette[0] === undefined, query.palette[2] === undefined);
console.log(0 in query.palette, 2 in query.palette, 3 in query.palette);
console.log(query.timer === undefined);

// The mapper runs once per index, in order.
const seen: number[] = [];
const mapped: undefined[] = Array.from({ length: 4 }, (_value, index) => {
  seen.push(index);
  return undefined;
});
console.log(mapped.length, seen.join(","));
console.log(mapped.every((value) => value === undefined));

// Array.from over an existing array, and `.map` over an existing array,
// both with a discarding mapper.
const fromArray: undefined[] = Array.from([1, 2, 3], (_n) => undefined);
console.log(fromArray.length, fromArray[0] === undefined);
const discarded: undefined[] = ["a", "b"].map((_text) => undefined);
console.log(discarded.length, discarded[1] === undefined);

// A dense literal of undefined elements keeps the same shape.
const literal: undefined[] = [undefined, undefined];
console.log(literal.length, literal[1] === undefined);

console.log(JSON.stringify(query.palette));
console.log(JSON.stringify(mapped));
