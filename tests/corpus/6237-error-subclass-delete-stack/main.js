// Deleting `stack` on an Error subclass that declares a stack accessor
// lets reads reach the accessor (the package's guest exceptions).
import { GuestError } from "guest-error";

try {
  throw new GuestError(7);
} catch (e) {
  console.log(e instanceof GuestError, e instanceof Error, e.handle, e.message);
  console.log(e.stack);
  e.stack = "rewritten";
  console.log(e.stack, Object.keys(e));
}
