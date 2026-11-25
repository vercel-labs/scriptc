// `(p as any).k = v` on a record whose layout does not declare `k`: Node
// adds the property to the object, and a native record has no slot for an
// undeclared member, so the write is refused by name. A declared member is
// written in place (tests/corpus/8879-any-asserted-record-write.ts).
interface Point {
  x: number;
}

function tag(point: Point): void {
  (point as any).tag = "t";
}

function tagThroughWrappers(point: Point | undefined): void {
  (point as any)!.tag = "t";
}

// A declared member takes only what its slot can hold.
function retype(point: Point): void {
  (point as any).x = "one";
}

tag({ x: 1 });
tagThroughWrappers({ x: 1 });
retype({ x: 1 });
