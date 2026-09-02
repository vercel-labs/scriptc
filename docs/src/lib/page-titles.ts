export const PAGE_TITLES: Record<string, string> = {
  "": "TypeScript-to-Native\nCompiler",
  introduction: "Introduction",
  quickstart: "Quickstart",
  cli: "CLI Reference",
  coverage: "Coverage Reports",
  dependencies: "npm Dependencies",
  ffi: "Native FFI",
  "native-objects": "Native Program Objects",
  platforms: "Platform Support",
  compatibility: "Node.js 24 Compatibility",
  "how-it-works": "How It Works",
  limitations: "Limitations",
};

export function getPageTitle(slug: string): string | null {
  return slug in PAGE_TITLES ? PAGE_TITLES[slug]! : null;
}
