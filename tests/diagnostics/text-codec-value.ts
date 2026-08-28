const encoder = new TextEncoder();
console.log(encoder);

function encodeCaptured(s: string): Uint8Array {
  return sharedEncoder.encode(s);
}
const sharedEncoder = new TextEncoder();
console.log(encodeCaptured("x").length);

let codecCase = 1;
switch (codecCase) {
  case 0:
    const caseEncoder = new TextEncoder();
    break;
  case 1:
    const Encoded = class {
      bytes = caseEncoder.encode("should fence");
    };
    console.log(new Encoded().bytes.length);
    break;
  case 2:
    // @ts-expect-error -- dispatch can enter here while caseEncoder is in its TDZ
    console.log(caseEncoder.encode("should fence directly").length);
    break;
}
