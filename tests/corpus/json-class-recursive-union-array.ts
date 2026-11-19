// A recursive union through an array (`Json = string | Json[] | Inner`) as a
// class field's element type: the callback analysis walks the type graph, and
// a type reached again is not a record element the rest of the walk has not
// seen.
class Inner {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}

type Json = string | Json[] | Inner;

// An instance that took a property through an untyped reference keeps its
// class on the runtime walk, which makes the field a callback-capable member.
const loose: any = new Inner(1);
loose.extra = 2;

class Box {
  value: Json[];
  constructor(value: Json[]) {
    this.value = value;
  }
}

const list: Json[] = [["a"], new Inner(3)];
console.log(JSON.stringify(new Box(list)));
