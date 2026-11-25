// A class or function another module assigned to the global object is
// visible here as an identifier.
import { frameArea } from "./polyfill.mjs";

const frame = new Frame(new Uint8ClampedArray(16), 2, 2);
console.log(frame instanceof Frame, frame.width, frame.height, frame.data.length);
console.log(frameArea(frame), typeof Frame, typeof makeFrame);

const made = makeFrame(3, 2);
console.log(made instanceof Frame, made.data.length, frameArea(made));

function decode(width, height) {
  const out = new Frame(new Uint8ClampedArray(width * height * 4), width, height);
  out.data[0] = 255;
  return out;
}
const decoded = decode(4, 4);
console.log(decoded.data[0], decoded.data.length, decoded.constructor.name);
