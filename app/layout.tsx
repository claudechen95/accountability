import type { Metadata } from "next";
import "./globals.css";
import BottomNav from "./components/BottomNav";

export const metadata: Metadata = {
  title: "Accountability Tracker",
  description: "Daily accountability tracker",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8f7f4] pb-20">
        {children}
        <BottomNav />
      </body>
    </html>
  );
}
