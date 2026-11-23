import { defineConfig } from "@vercel/geistdocs/config";
import { description, githubUrl, siteName, siteUrl } from "@/lib/site";

const [owner, repo] = new URL(githubUrl).pathname.slice(1).split("/");

export const config = defineConfig({
  title: siteName,
  siteUrl,
  defaultLanguage: "en",
  translations: { en: { displayName: "English" } },
  logo: (
    <span className="translate-y-[-0.5px] flex items-center font-[family-name:var(--font-geist-sans)] text-[24.4px] font-semibold tracking-[-0.05em] text-black dark:text-white">
      {siteName}
    </span>
  ),
  navbarBrand: "labs",
  navbarActiveProduct: siteName,
  github: { owner, repo, branch: "main", editPath: "docs/content/docs/{path}" },
  content: [{ id: "docs", label: "Documentation", dir: "content/docs", route: "/docs" }],
  nav: [
    { label: "Docs", href: "/docs" },
    { label: "Compatibility", href: "/compatibility" },
  ],
  search: { enabled: true },
  ai: { enabled: false },
  feedback: { enabled: false },
  language: { enabled: false },
  pageActions: { askAI: false, openInChat: false },
  webmcp: { enabled: true },
  agent: {
    product: {
      name: siteName,
      description,
      category: "Compiler",
      useCases: ["Compile TypeScript or JavaScript to native executables", "Check a program's compilation coverage", "Build WebAssembly modules"],
    },
    links: [{ label: "Node.js compatibility", href: "/compatibility" }],
    mcp: { manifestUrl: "/.well-known/mcp.json", servers: [{ name: `${siteName} docs`, url: "/api/mcp" }] },
  },
});
