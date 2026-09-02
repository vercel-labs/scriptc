"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navSections } from "@/lib/docs-navigation";
import { DocsToc } from "@/components/docs-toc";

function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      {/* overscroll-contain: sidebar edge-scroll must not chain to the page. */}
      <nav className="fixed top-16 w-56 h-[calc(100vh-4rem)] overflow-y-auto overscroll-contain py-8 pr-4 space-y-6">
        {navSections.map((section) => (
          <div key={section.title}>
            <div className="mb-2 px-3 label-12 font-medium uppercase tracking-wider text-gray-900">
              {section.title}
            </div>
            <div className="space-y-0.5">
              {section.items.map(({ href, name }) => {
                const active = pathname === href;
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-gray-alpha-100 font-medium text-gray-1000"
                        : "text-gray-900 hover:text-gray-1000"
                    }`}
                  >
                    {name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function DocsNav({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Top-level site pages bypass the documentation sidebar and article shell.
  if (pathname === "/") {
    return <main>{children}</main>;
  }
  if (pathname === "/compatibility") {
    return <main className="h-[calc(100dvh-4rem)] overflow-hidden">{children}</main>;
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 lg:py-12 xl:max-w-7xl">
      <div className="flex gap-12">
        <Sidebar />
        <main className="min-w-0 flex-1">
          <article className="max-w-none">{children}</article>
        </main>
        {/* The rail keeps its slot on every page so content width is stable
            across navigation, even when a page has no headings to list. */}
        <aside className="hidden w-52 shrink-0 xl:block">
          <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto overscroll-contain">
            <DocsToc />
          </div>
        </aside>
      </div>
    </div>
  );
}
