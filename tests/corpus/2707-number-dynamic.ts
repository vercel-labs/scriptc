function testNumber(x: any) {
  const n = Number(x);
  console.log(isNaN(n) ? "NaN" : n);
  console.log("isFinite:", Number.isFinite(x));
  console.log("isNaN:", Number.isNaN(x));
  console.log("isInteger:", Number.isInteger(x));
  console.log("isSafeInteger:", Number.isSafeInteger(x));
}

testNumber("42");
testNumber(true);
testNumber(false);
testNumber(null);
testNumber(undefined);
testNumber(100);
testNumber(100.5);
testNumber(NaN);
testNumber(Infinity);

function testUnion(x: string | number | boolean | null | undefined) {
  const n = Number(x);
  console.log(isNaN(n) ? "NaN" : n);
}
testUnion("999");
testUnion(123);
testUnion(true);
testUnion(null);
testUnion(undefined);
