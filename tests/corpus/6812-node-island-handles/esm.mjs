export const kind = "esm";
export let counter = 0;
export function bump() {
  return ++counter;
}
export default { name: "default export" };
