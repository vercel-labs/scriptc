// The project's own declaration file: types only. A setting holds scalars,
// lists of settings and nested groups of settings.
export interface Group {
  [name: string]: Setting;
}
export type Setting = string | number | boolean | null | Group | Setting[];
export interface Profile {
  label: string;
  rank: number;
  tags?: string[];
}
