class Pair {
  a = 1;
  b = 2;
}

function earlierGenericSource<T>(_: T): void {
  const value = { b: 2, a: 1 };
  console.log(Object.keys(value).length);
}

function earlierOrdinary(): void {
  earlierGenericSource(1);
}

function laterGeneric<T>(_: T): void {
  const sameShape = { a: 1, b: 2 };
  console.log(Object.keys(sameShape).length);
  earlierOrdinary();
  // The deferred rest-order rejection must poison this whole statement:
  // the later WeakMap declarator is never visited, and the next statement
  // sees rest as a blocked binding just like the historical emit pass.
  const { ...rest } = new Pair(), blocked = new WeakMap<object, number>();
  console.log(Object.keys(rest).join(","), blocked);
}

laterGeneric(1);
