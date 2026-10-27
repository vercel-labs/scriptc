import { StampDate } from "./date.js";
import { ParseError } from "./error.js";
function parse(text) {
  if (text === "") throw new ParseError("empty document", 1);
  const [key, value] = text.split("=").map((part) => part.trim());
  return { key, value };
}
function stringify(value) {
  return JSON.stringify(value);
}
// A default export object of functions and class values (the shorthand
// spelling of `{ ParseError: ParseError }`).
export default { parse, stringify, StampDate, ParseError };
export { parse, stringify, StampDate, ParseError };
