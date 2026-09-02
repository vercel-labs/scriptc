import createMDX from "@next/mdx";
import { createRequire } from "node:module";

// Resolve the plugin to an absolute path (still a string, so the config
// stays serializable for Turbopack). A bare "remark-gfm" is require()d
// from the MDX loader's own package context, which under pnpm's strict
// module isolation cannot see this app's dependencies — production
// builds resolved it, the Turbopack dev server did not.
const require = createRequire(import.meta.url);

const withMDX = createMDX({
  options: {
    // GFM is what gives .mdx pages autolinks and strikethrough. Tables are
    // authored as literal HTML per AGENTS.md, but the plugin stays so a
    // stray pipe table degrades gracefully instead of rendering as a
    // paragraph of pipes.
    remarkPlugins: [[require.resolve("remark-gfm")]],
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  // CI-style builds set NEXT_DIST_DIR so `pnpm check` never shares .next
  // with a running dev server (a shared dist dir corrupts the dev cache).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default withMDX(nextConfig);
