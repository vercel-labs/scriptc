// A Proxy over a class instance or an array: the native Proxy wraps untyped
// objects, functions and plain records, and refuses these every time.
class Box {
  size = 1;
}
const boxed = new Proxy(new Box(), {});
const listed = new Proxy([1, 2, 3], {});
console.log(boxed.size, listed.length);
