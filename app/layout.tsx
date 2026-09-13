import type { Metadata } from "next";
import "./globals.css";
import BottomNav from "./components/BottomNav";
import { getUsers } from "@/lib/kv";

export const metadata: Metadata = {
  title: "Accountability Tracker",
  description: "Daily accountability tracker",
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
        {children}
        <BottomNav hiddenByUser={hiddenByUser} />
      </body>
    </html>
  );
}
