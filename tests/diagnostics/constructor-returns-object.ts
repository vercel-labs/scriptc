// Node's `new Point()` answers the object a constructor returns. A plain
// object has no representation as a Point instance, so the return refuses
// instead of answering the constructed instance.
class Point {
  x = 1;
  constructor() {
    return { x: 2 };
  }
}
console.log(new Point().x);
