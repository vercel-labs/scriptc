import { settings } from "./settings.ts";
export function summary(): string {
  return settings.label + ":" + settings.depth;
}
