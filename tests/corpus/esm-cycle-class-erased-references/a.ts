import { DerivedBase, choice, probe, Impl } from "./b.ts";

export const caught = probe();
export class Target extends DerivedBase {}
export const choiceKind = choice.kind;
export const implKind = new Impl().kind;
export const lateKind = new Target().kind;
export function makeTarget(): Target {
  return new Target();
}
