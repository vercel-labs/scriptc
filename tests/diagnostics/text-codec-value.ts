const encoder = new TextEncoder();

function encodeCaptured(s: string): Uint8Array {
  return sharedEncoder.encode(s);
}

const decoder = new TextDecoder();
new TextDecoder("utf-8", { fatal: true });
encoder.encodeInto("hello", new Uint8Array(10));
const forged = JSON.parse("{}") as TextDecoder;
console.log(forged.decode());
const sharedEncoder = new TextEncoder();
console.log(encodeCaptured("x").length);
// A module var's pre-initialization value is not a codec instance.
var varEncoder = new TextEncoder();
let uninitializedDecoder: TextDecoder;
function earlyVarCapture(): Uint8Array {
  const use = () => localEncoder.encode("x");
  const bytes = use();
  var localEncoder = new TextEncoder();
  return bytes;
}
console.log(earlyVarCapture().length);

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
