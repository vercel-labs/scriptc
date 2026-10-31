// The project's replacement for eventlog's dist/entry.d.ts.
export type Entry = {
  at: number;
  level: "info" | "warn" | "error";
  user?: string;
  message: string;
};
