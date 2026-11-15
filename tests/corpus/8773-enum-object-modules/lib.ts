console.log("lib starts");
export enum Dir {
  Up = 1,
  Down,
}
export enum Tone {
  Hi = "hi",
  Lo = "lo",
}
enum Inner {
  P,
  Q,
}
export { Inner as Renamed };
export default Inner;
export const enum Fixed {
  A = 4,
}
// Used only through its members, here and by the importer: no object.
export enum MembersOnly {
  X = 1,
  Y,
}
export function dirNames(): string[] {
  return Object.keys(Dir);
}
console.log("lib ends", Object.values(Tone).join(","), MembersOnly.Y);
