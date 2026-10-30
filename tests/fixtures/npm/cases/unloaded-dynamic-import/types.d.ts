// Types for the two packages the project marks never loaded. Neither is
// installed here; tests/harness/package-shims.test.ts installs both.
declare module "wsunloadedparser" {
  export function parse(text: string): string;
}
declare module "gtunloadedheavy" {
  export function heavy(text: string): string;
}
