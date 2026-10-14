// Reading `.then` (and `catch`/`finally`) off a promise held in `any`
// storage must answer like Node: the shared Promise.prototype method
// values, not undefined. Regression test: the then-presence probe only
// engaged for receivers whose checker type mapped to a promise, so
// `typeof p.then === "function"` and the bare value read answered
// undefined for untyped and `any` parameters.
function probeThen(p: any): void {
  console.log("typeof then:", typeof p.then);
  console.log("then is function:", typeof p.then === "function");
  console.log("then defined:", p.then !== undefined);
}

function probeMethods(p: any): void {
  console.log("typeof catch:", typeof p.catch);
  console.log("typeof finally:", typeof p.finally);
}

function probeMissing(p: any): void {
  console.log("typeof absent:", typeof p.missing);
}

function probeThenable(x: any): void {
  console.log("thenable then:", typeof x.then);
}

function makePromise(): Promise<number> {
  return Promise.resolve(1);
}

probeThen(makePromise());
probeThen(42);
probeMethods(makePromise());
probeMissing(makePromise());
probeThenable({ then: 42 });
probeThenable({});
