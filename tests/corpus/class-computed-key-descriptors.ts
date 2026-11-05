// Two functions define computed-key properties on instances of one class.
class Point {
  x = 1;
  y = 2;
}

function defineValue(p: Point, key: string, value: number): void {
  Object.defineProperty(p, key, { value, writable: true, enumerable: true, configurable: true });
}

function defineHidden(p: Point, key: string): void {
  Object.defineProperty(p, key, { value: "hidden", writable: false, enumerable: false, configurable: true });
}

const p = new Point();
defineValue(p, "z", 3);
defineHidden(p, "label");
console.log(JSON.stringify(p));
console.log(Object.keys(p).join(","));
