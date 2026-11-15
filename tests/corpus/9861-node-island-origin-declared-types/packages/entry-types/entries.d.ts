export interface Entry {
  name: string;
  count: number;
  nested: { level: number };
  label(): string;
}
