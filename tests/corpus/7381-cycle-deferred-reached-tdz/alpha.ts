import { probe } from "./beta.ts";

export function report(): string {
  return `alpha ${NAME}`;
}

export function late(): string {
  return `${OTHER} after ${probe}`;
}

export const NAME = "ready";
export const OTHER = "other";
console.log("alpha body", report());
