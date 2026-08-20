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
  const { ...rest } = new Pair();
  console.log(Object.keys(rest).join(","));
}

laterGeneric(1);
