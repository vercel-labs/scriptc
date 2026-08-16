declare function nativeScale(value: number): number;
declare function nativeInvert(value: boolean): boolean;
declare function nativeU8(value: number): number;
declare function nativeU32(value: number): number;
declare function nativeI32(value: number): number;
declare function nativeTextSum(value: string): number;
declare function nativeBytesSum(value: Uint8Array): number;
declare function nativeNote(value: number): void;
declare function nativeLastNote(): number;
declare function nativeApply(callback: (value: number) => number, value: number): number;
declare function nativeCombineRaw(
  left: (value: number) => number,
  right: (value: number) => number,
  value: number,
): number;
declare function nativeCallbackSymbolCollision(callback: (value: number) => number): number;
declare function nativeCallbackTlsCollision(value: number): number;
declare function nativeCallbackMix(
  callback: (
    truth: boolean,
    byte: number,
    wide: number,
    signedValue: number,
    fraction: number,
  ) => number,
): number;
declare function nativeEach(callback: (value: number) => void): void;
declare function nativePropVisit(callback: (id: number, name: string) => void): void;
declare function nativeCallbackSpans(
  callback: (text: string, bytes: Uint8Array) => void,
): void;
declare function nativeCallbackStringThrow(callback: (value: string) => void): void;
declare function nativeNullCString(callback: (value: string) => void): void;

console.log(nativeScale(21));
console.log(nativeInvert(false), nativeInvert(true));
console.log(nativeU8(258), nativeU32(-1), nativeI32(4294967295));
console.log(nativeTextSum("A\0é"));
console.log(nativeBytesSum(new Uint8Array([1, 2, 3])));
nativeNote(12.5);
console.log(nativeLastNote());

const offset = 7;
console.log(nativeApply((value) => value + offset, 5));

const leftOffset = 3;
const rightFactor = 4;
console.log(nativeCombineRaw((value) => value + leftOffset, (value) => value * rightFactor, 5));
console.log(nativeCallbackSymbolCollision((value) => value + 1));
console.log(nativeCallbackTlsCollision(41));

console.log(nativeCallbackMix((truth, byte, wide, signedValue, fraction) => {
  console.log(truth, byte, wide, signedValue, fraction);
  return -1;
}));

let total = 0;
nativeEach((value) => {
  total += value;
});
console.log(total);

const properties: string[] = [];
nativePropVisit((id, name) => {
  properties.push(`${id}:${name}`);
});
console.log(properties.join("|"));

let copiedText = "";
let copiedBytes: Uint8Array = new Uint8Array(0);
nativeCallbackSpans((text, bytes) => {
  if (text.length === 0) {
    console.log(text.length, text.charCodeAt(1), text.slice(2), bytes.join(","));
  } else {
    copiedText = text;
    copiedBytes = bytes;
  }
});
console.log(copiedText.length, copiedText.charCodeAt(1), copiedText.slice(2), copiedBytes.join(","));

try {
  nativeApply(() => {
    throw new Error("callback boom");
  }, 1);
} catch (error) {
  console.log("caught", (error as Error).message);
}

try {
  nativeCallbackStringThrow((value) => {
    throw new Error(`string callback boom: ${value}`);
  });
} catch (error) {
  console.log("caught", (error as Error).message);
}
