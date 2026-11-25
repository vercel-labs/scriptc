// A checked element read is stabilized in a hidden local and its field is lent
// to the stable local `value`. That local outlives the statement, and the
// temporary array the read came from dies with it, so the field must take its
// own count: a lent field is freed with its box before `value` is used, and the
// next string allocation reuses its bytes.
export {};

class Box {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

function boxes(s: string): Box[] {
  return [new Box(s + "!!")];
}

function main(): void {
  const value = boxes("abcdefghij")[0].value;
  const fresh = "Z".repeat(value.length);
  console.log(fresh.length, value.length, value.charCodeAt(0), value.charCodeAt(11));
  console.log(value);
}

main();
