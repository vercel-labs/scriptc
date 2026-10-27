import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGeistdocs } from "@vercel/geistdocs/next";

const withGeistdocs = createGeistdocs();
const legacySlugs = ["quickstart", "coverage", "dependencies", "ffi", "native-objects", "wasm", "platforms", "cli", "how-it-works", "limitations"];

// The compatibility page fetches its data under a content hash of the
// committed artifact, so a deploy never serves a cached older copy, and
// checks the row count it expects. Both are derived here at build time.
const compatibilityArtifact = readFileSync(new URL("./src/generated/node-v24-compatibility.json", import.meta.url), "utf8");

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    COMPATIBILITY_ARTIFACT_VERSION: createHash("sha256").update(compatibilityArtifact).digest("hex").slice(0, 20),
    COMPATIBILITY_ROW_COUNT: String(JSON.parse(compatibilityArtifact).rows.length),
  },
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  skipProxyUrlNormalize: true,
  async redirects() {
    return [
      { source: "/introduction", destination: "/docs", permanent: true },
      { source: "/docs/introduction", destination: "/docs", permanent: true },
      ...legacySlugs.map((slug) => ({ source: `/${slug}`, destination: `/docs/${slug}`, permanent: true })),
    ];
  },
  outputFileTracingIncludes: { "/og/[...slug]": ["./public/*.ttf"], "/og": ["./public/*.ttf"] },
};

export default withGeistdocs(nextConfig);
