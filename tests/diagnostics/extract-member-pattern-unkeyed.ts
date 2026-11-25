// `Extract<U, { kind: K }>` in a generic body maps to the member K's bound
// literal selects only where the body itself names that pattern: the
// function then has one instance per literal. A pattern the body reaches
// some other way leaves the instance shared by every literal, so the type
// has no one member to be and stays unmapped.
type Circle = { kind: "circle"; meta: { tag: "round" }; radius: number };
type Square = { kind: "square"; meta: { tag: "flat" }; side: number };
type Shape = Circle | Square;
type ByKind<K extends Shape["kind"]> = Extract<Shape, { kind: K }>;

// The pattern sits in an alias: the body names only `ByKind<K>`.
function viaAlias<K extends Shape["kind"]>(shape: Shape, kind: K): ByKind<K> | undefined {
  return shape.kind === kind ? (shape as ByKind<K>) : undefined;
}

// The parameter sits one level down: the pattern's member is not a literal.
function nested<T extends Shape["meta"]["tag"]>(
  shape: Shape,
  tag: T,
): Extract<Shape, { meta: { tag: T } }> | undefined {
  return shape.meta.tag === tag ? (shape as Extract<Shape, { meta: { tag: T } }>) : undefined;
}

console.log(viaAlias({ kind: "circle", meta: { tag: "round" }, radius: 1 }, "circle")?.radius);
console.log(nested({ kind: "square", meta: { tag: "flat" }, side: 2 }, "flat")?.side);
