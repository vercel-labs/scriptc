export enum Level {
  Low,
  High,
}

export function label(level: Level): string {
  return level === Level.High ? "high" : "low";
}
