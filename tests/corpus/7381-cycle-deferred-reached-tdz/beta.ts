import { report } from "./alpha.ts";

function attempt(): string {
  try {
    return report();
  } catch (error) {
    return error instanceof ReferenceError ? `ReferenceError: ${error.message}` : "other error";
  }
}

export const probe = attempt();
console.log("beta body", probe);
