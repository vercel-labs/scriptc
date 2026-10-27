import { shout } from "gtshout";

export function greet(name: string): string {
  return `hello, ${shout(name)}`;
}
