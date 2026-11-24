import type { Metadata } from "next";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { DocsProvider } from "@/components/geistdocs/provider";
import { config } from "@/lib/geistdocs/config";
import { versionedOgImage } from "@/lib/og-version";
import { siteName, siteUrl, tagline, description, ogHomeTitle } from "@/lib/site";
import "./globals.css";

const ogImage = versionedOgImage("/og", ogHomeTitle);

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${siteName} | ${tagline}`, template: `%s | ${siteName}` },
  description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName,
    title: `${siteName} | ${tagline}`,
    description,
    images: [{ url: ogImage, width: 1200, height: 630, alt: siteName }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteName} | ${tagline}`,
    description,
    images: [{ url: ogImage, width: 1200, height: 630, alt: siteName }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable} ${GeistPixelSquare.variable} antialiased`}>
      <body>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <DocsProvider>
          <Navbar config={config} />
          {children}
          <Footer />
        </DocsProvider>
      </body>
    </html>
  );
}
