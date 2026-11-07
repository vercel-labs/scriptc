// A record with an index signature keeps its own layout in a callee that
// writes through the parameter, so the callee's body compiles against that
// layout. A write by a runtime key that could land on a field of another
// type does not compile there, and no copy converts the record either: the
// call refuses.
type Common = { [key: string]: string } & { id: string };
type Counted = Common & { count: number };

function put(target: Common, key: string, value: string): void {
  target.id += "!";
  target[key] = value;
}

const plain: Common = { id: "p" };
put(plain, "extra", "e");
console.log(plain.id, plain.extra);

const counted = { id: "c", count: 1 } as Counted;
put(counted, "extra", "e");
console.log(counted.id, counted.extra, counted.count);
