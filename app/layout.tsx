import type { Metadata, Viewport } from "next";
import "./globals.css";
import BottomNav from "./components/BottomNav";
import PwaManifest from "./components/PwaManifest";
import PullToRefresh from "./components/PullToRefresh";
import { getUsers } from "@/lib/kv";

export const viewport: Viewport = {
  themeColor: "#f8f7f4",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Accountability Tracker",
  description: "Daily accountability tracker",
  applicationName: "Accountability",
  appleWebApp: {
    capable: true,
    title: "Accountability",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // One `get` of the small `users` key, read here rather than in the nav so a tab a user has
  // switched off is missing from the HTML instead of being removed a moment after hydration.
  // The nav can't read it itself: it's a client component, and it's in the layout rather than
  // per page, so there's nowhere else this can be fetched without a client round trip.
  const users = await getUsers();
  const hiddenByUser = Object.fromEntries(
    users.filter((u) => u.hiddenTabs?.length).map((u) => [u.id, u.hiddenTabs!])
  );

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8f7f4] pb-20">
        <PwaManifest />
        <PullToRefresh />
        {children}
        <BottomNav hiddenByUser={hiddenByUser} />
      </body>
    </html>
  );
}
