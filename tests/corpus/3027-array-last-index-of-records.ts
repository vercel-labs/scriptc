interface Item { id: number }
const first: Item = { id: 1 };
const second: Item = { id: 2 };
const refs: Item[] = [first, second, first];
console.log(refs.lastIndexOf(first), refs.lastIndexOf(second), refs.lastIndexOf({ id: 1 }));
console.log(refs.lastIndexOf(first, 1), refs.lastIndexOf(second, 0));
console.log(refs.lastIndexOf(refs[0]), refs.lastIndexOf(refs[1]));
