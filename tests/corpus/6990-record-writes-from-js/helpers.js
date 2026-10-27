// Untyped helpers that add, replace and remove properties of the objects
// they receive.
export function write(target, key, value) {
  target[key] = value;
}

export function remove(target, key) {
  delete target[key];
}

export function keysOf(target) {
  return Object.keys(target).join(",");
}
