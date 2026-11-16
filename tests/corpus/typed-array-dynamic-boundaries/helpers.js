// Untyped JavaScript that receives arrays from the typed program, keeps
// them, and hands them back. `list()` answers a fresh array of strings,
// `same` answers the array it was given, and `add` writes through it.
export function list() {
  return ["loaded", "ready"];
}

export function same(value) {
  return value;
}

export function add(value, item) {
  value.push(item);
  return value.length;
}

export function sizeOf(value) {
  return new Set(value).size;
}

export function from(value) {
  return Array.from(value);
}

export function pairs() {
  return [["from-js", 2]];
}
