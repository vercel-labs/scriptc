// The SDK module the entry re-exports: mutable handler state lives here,
// away from the entry file, so the export facade never redeclares it.
let suffix = "!";

export function setSuffix(next: string): void {
  suffix = next;
}

export function handle(msg: string): string {
  return msg.toUpperCase() + suffix;
}
