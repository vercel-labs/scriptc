export function call(fn, value) {
  return fn(value);
}

export function read(object, key) {
  return `${String(object[key])}`;
}

export function readSymbol(object, key) {
  return `${String(object[key])}`;
}

export function write(object, key, value) {
  object[key] = value;
  return "written";
}
