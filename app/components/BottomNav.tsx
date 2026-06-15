"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  {
    href: "/",
    label: "Home",
    icon: (active: boolean) => (
      <svg viewBox="0 0 24 24" fill="none" strokeWidth={active ? 2.5 : 1.8} stroke="currentColor" className="w-6 h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
      </svg>
    ),
  },
  {
    href: "/mood",
    label: "Mood",
    icon: (active: boolean) => (
      <svg viewBox="0 0 24 24" fill="none" strokeWidth={active ? 2.5 : 1.8} stroke="currentColor" className="w-6 h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75s.168-.75.375-.75.375.336.375.75zm4.5 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75zM12 18.75a6.75 6.75 0 100-13.5 6.75 6.75 0 000 13.5z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 13.5s.75 1.5 3 1.5 3-1.5 3-1.5" />
      </svg>
    ),
  },
  {
    href: "/notes",
    label: "Notes",
    icon: (active: boolean) => (
      <svg viewBox="0 0 24 24" fill="none" strokeWidth={active ? 2.5 : 1.8} stroke="currentColor" className="w-6 h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
      </svg>
    ),
  },
  {
    href: "/history",
    label: "History",
    icon: (active: boolean) => (
      <svg viewBox="0 0 24 24" fill="none" strokeWidth={active ? 2.5 : 1.8} stroke="currentColor" className="w-6 h-6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  },
];

const KNOWN_FIRST_SEGMENTS = new Set(["mood", "notes", "history"]);

export default function BottomNav() {
  const pathname = usePathname();

  // No nav on the landing page
  if (pathname === "/") return null;

  // If the first path segment isn't a known route, treat it as a user prefix (e.g. /claude)
  const firstSegment = pathname.split("/").filter(Boolean)[0];
  const userBase = firstSegment && !KNOWN_FIRST_SEGMENTS.has(firstSegment) ? `/${firstSegment}` : "";

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/90 backdrop-blur border-t border-gray-200">
      <div className="max-w-md mx-auto flex">
        {TABS.map((tab) => {
          const tabHref = tab.href === "/" ? userBase || "/" : userBase + tab.href;
          const active =
            tab.href === "/"
              ? pathname === "/" || pathname === userBase
              : pathname.startsWith(userBase + tab.href);
          return (
            <Link
              key={tab.href}
              href={tabHref}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors ${
                active ? "text-indigo-600" : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {tab.icon(active)}
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
