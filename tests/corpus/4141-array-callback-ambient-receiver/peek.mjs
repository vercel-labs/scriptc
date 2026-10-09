// A plain function reading its own receiver: undefined for a plain call.
export function peek() {
  return this === undefined ? "undefined" : typeof this;
}
