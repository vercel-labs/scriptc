import type { MetadataRoute } from "next";
import { allDocsPages } from "@/lib/docs-navigation";
import { siteUrl } from "@/lib/site";
import { statSync } from "node:fs";
import path from "node:path";

export default function sitemap(): MetadataRoute.Sitemap {
  // Top-level site pages live in the header, not the docs nav.
  const hrefs = ["/", "/compatibility", ...allDocsPages.map((page) => page.href)];
  return hrefs.map((href) => ({
    url: `${siteUrl}${href}`,
    lastModified: lastModifiedFor(href),
  }));
}

function lastModifiedFor(href: string): Date {
  const relative = href === "/" || href === "/compatibility" ? path.join(href.slice(1), "page.tsx") : path.join(href.slice(1), "page.mdx");
  try {
    return statSync(path.join(process.cwd(), "src", "app", relative)).mtime;
  } catch {
    return new Date("2026-07-22T00:00:00.000Z");
  }
}
