// An unchecked outer array read still produces JavaScript's undefined at
// runtime. A nested read must validate that receiver before typed tuple,
// record, or inner-array access reaches the native backend.
const pairs: [string, string][] = [["a", "b"]];
const records: { value: number }[] = [{ value: 9 }];
const matrix: number[][] = [[3]];

function readPair(index: number): void {
  try {
    console.log("pair", pairs[index][0]);
  } catch (error) {
    console.log("pair-error", error instanceof TypeError, typeof error);
  }
}

function readRecord(index: number): void {
  try {
    console.log("record", records[index].value);
  } catch (error) {
    console.log("record-error", error instanceof TypeError, typeof error);
  }
}

function readMatrix(index: number): void {
  try {
    console.log("matrix", matrix[index][0]);
  } catch (error) {
    console.log("matrix-error", error instanceof TypeError, typeof error);
  }
}

readPair(0);
readPair(1);
readRecord(0);
readRecord(1);
readMatrix(0);
readMatrix(1);
