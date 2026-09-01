// timingSafeEqual must preserve Node's exact mismatched-length RangeError
// message, as well as the equal-length result.
import { timingSafeEqual } from "node:crypto";

try {
  timingSafeEqual(Buffer.from("a"), Buffer.from("ab"));
} catch (err) {
  console.log(err instanceof RangeError, (err as Error).message);
}

console.log(timingSafeEqual(Buffer.from("same"), Buffer.from("same")));
console.log(timingSafeEqual(Buffer.from("same"), Buffer.from("diff")));
