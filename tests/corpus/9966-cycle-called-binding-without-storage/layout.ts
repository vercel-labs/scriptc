import { peek, slurp } from "./ledger.ts";

function attempt(run: () => unknown): string {
  try {
    run();
    return "no error";
  } catch (err) {
    return (err as Error).name + ": " + (err as Error).message;
  }
}

// This module is evaluated before ledger.ts: both calls reach the binding
// while it is in its temporal dead zone, through the function that names it
// and through the name this module imports it under.
export const EARLY = [attempt(() => peek("unread")), attempt(() => slurp("unread", "utf8"))];

export function banner(rows: string[]): string {
  return `${rows.length} rows: ${rows.join(", ")}`;
}

// Called after both modules ran: the same two calls succeed.
export async function later(path: string): Promise<string> {
  const viaImport = await slurp(path, "utf8");
  const viaFunction = await peek(path);
  return viaImport.length + " " + (viaImport === viaFunction);
}
