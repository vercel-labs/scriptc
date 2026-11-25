export const now = (): number => 1;
export const later = (): number => 2;
let counter = 3;
export default counter;
export function bump(): void {
  counter = 4;
}
