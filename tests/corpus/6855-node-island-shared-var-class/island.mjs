import { Shape, makeShape } from "./shapes.mjs";
import { KitError, codeOf, fail, isKitError } from "kit";

export function hello() {
  return "island loaded";
}

export function area(side) {
  const made = makeShape(side);
  return `${new Shape(side).area()} ${made.area()} ${made instanceof Shape}`;
}

export function make(code) {
  return new KitError("made in the island", code);
}

export function check(e) {
  return `${e instanceof KitError} ${isKitError(e)} code=${codeOf(e)}`;
}

export function caught(code) {
  try {
    fail(code);
  } catch (e) {
    return `${e instanceof KitError} ${e.name} ${e.message} ${e.code}`;
  }
  return "not thrown";
}

export function sameClass(shape, error) {
  return `${shape === Shape} ${error === KitError}`;
}

export function raise(code) {
  throw new KitError("thrown by the island", code);
}
