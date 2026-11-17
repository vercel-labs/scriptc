import { makeTarget, Target } from "./a.ts";

export class DerivedBase {
  readonly kind: string = "base";
}

const wantTarget = false;
// Only the arm that runs is read, so the other arm's temporal dead zone is
// never observed — and the condition's own work runs first, as it does
// under Node.
let order = "";
function pick(): boolean {
  order += "pick;";
  return wantTarget;
}
export class Choice extends (pick() ? Target : DerivedBase) {}
export const choice = new Choice();
export const choiceOrder = order;

// `implements` names a type: Node erases it, so the class statement reads
// nothing from the cycle.
export class Impl implements Target {
  readonly kind: string = "impl";
}

export function probe(): string {
  try {
    return makeTarget().kind;
  } catch (error) {
    return `${(error as Error).name}: ${(error as Error).message}`;
  }
}
