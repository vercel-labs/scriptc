function testDate(x: any) {
  const d = new Date(x);
  console.log(isNaN(d.getTime()) ? "NaN" : d.getTime());
}

testDate(1700000000000);
testDate("2024-01-01T00:00:00.000Z");
testDate(true);
testDate(null);
testDate(undefined);

function testUnion(x: string | number) {
  const d = new Date(x);
  console.log(isNaN(d.getTime()) ? "NaN" : d.getTime());
}
testUnion(1700000000000);
testUnion("2024-01-01T00:00:00.000Z");
