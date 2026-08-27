export type NavItem = {
  name: string;
  href: string;
};

export type NavSection = {
  title: string;
  items: NavItem[];
};

export const navSections: NavSection[] = [
  {
    title: "Get Started",
    items: [
      { name: "Introduction", href: "/introduction" },
      { name: "Quickstart", href: "/quickstart" },
    ],
  },
  {
    title: "Guides",
    items: [
      { name: "Coverage Reports", href: "/coverage" },
      { name: "npm Dependencies", href: "/dependencies" },
      { name: "Native FFI", href: "/ffi" },
      { name: "Native Program Objects", href: "/native-objects" },
      { name: "Platform Support", href: "/platforms" },
    ],
  },
  {
    title: "Reference",
    items: [
      { name: "CLI Reference", href: "/cli" },
      { name: "How It Works", href: "/how-it-works" },
      { name: "Limitations", href: "/limitations" },
    ],
  },
];

export const allDocsPages: NavItem[] = navSections.flatMap((s) => s.items);
