import { current, record } from "./state.mjs";
export function bump() {
  return record();
}
export function seen() {
  return current();
}
