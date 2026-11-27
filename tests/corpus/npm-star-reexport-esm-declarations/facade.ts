// An installed ESM package that ships its declarations beside the runtime
// JavaScript: the star re-export must root the package's runtime entry, not
// only its declaration file, in both resolution worlds.
export * from "espkg";
