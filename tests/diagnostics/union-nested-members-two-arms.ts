// A record that fits several union arms enters the one arm that keeps every
// member it has, at every depth. Here two arms do, and they differ in a
// member the record lacks: the record's layout cannot say which arm it is,
// and the union has no discriminant to ask.

type Plain = { shape: { width: number; height: number } };
type Tinted = { shape: { width: number; height: number; tint?: string } };
type Framed = { shape: { width: number; height: number; frame?: number } };

function box(): Plain {
  return { shape: { width: 2, height: 3 } };
}

const picture: Tinted | Framed = box();
console.log(picture.shape.width);
