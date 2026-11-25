console.log("lib.mjs evaluating");
export const answer = 42;
export function later(ms, v) {
  return new Promise((r) => setTimeout(() => r(v), ms));
}
export default function hello() {
  return "default export";
}
