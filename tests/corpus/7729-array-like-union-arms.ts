// Arrays in unions whose array-like object arm accepts them
// (`{ length: number; [index: number]: T }`): the union holds the array
// itself, so Array.isArray, length, indexed reads, iteration and identity
// are the array's, whatever the element type of the union's array arm.
type Like = { length: number; [index: number]: number };
type Slot = string[] | Like;

function describe(s: Slot): string {
  if (Array.isArray(s)) return "array " + s.length + " " + typeof s[0];
  return "object " + s.length;
}

const literal: Slot = [3, 4, 5];
console.log(describe(literal));

const numbers = [3, 4, 5];
const bound: Slot = numbers;
console.log(describe(bound), describe(numbers), bound === numbers);
numbers.push(6);
console.log(describe(bound));

const strings: Slot = ["a", "b"];
console.log(describe(strings));
console.log(describe({ length: 2, 0: 1, 1: 2 }));

function total(s: Slot): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const item = s[i];
    sum += typeof item === "number" ? item : item.length;
  }
  return sum;
}
console.log(total(numbers), total(["ab", "c"]), total({ length: 1, 0: 9 }));
console.log(JSON.stringify(bound), JSON.stringify(strings));

// The same element type on both sides keeps the typed array arm.
type Numbers = number[] | { length: number; [index: number]: number };
function first(n: Numbers): number {
  return Array.isArray(n) ? n[0] : n.length;
}
console.log(first([7, 8]), first({ length: 1, 0: 6 }));
