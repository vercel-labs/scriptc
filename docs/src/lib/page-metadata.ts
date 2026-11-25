import type { Metadata } from "next";
import { versionedOgImage } from "./og-version";
import { PAGE_TITLES } from "./page-titles";
import { description, ogHomeTitle, siteName } from "./site";

export function pageMetadata(slug: string): Metadata {
  const title = PAGE_TITLES[slug];
  if (!title) return {};

  const displayTitle = title.replace(/\n/g, " ");
  const fullTitle = `${displayTitle} | ${siteName}`;
  const ogImageUrl = versionedOgImage(slug ? `/og/${slug}` : "/og", slug ? title : ogHomeTitle);

  return {
    title: displayTitle,
    description,
    alternates: { canonical: slug === "compatibility" ? "/compatibility" : slug === "introduction" ? "/docs" : `/docs/${slug}` },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName,
      title: fullTitle,
      description,
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `${displayTitle} - ${siteName}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [ogImageUrl],
    },
  };
}
