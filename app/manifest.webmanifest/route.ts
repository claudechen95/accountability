import { pwaStartPath } from "@/lib/pwa";

export const dynamic = "force-dynamic";

// start_url has to be the person who saved the app. iOS opens the manifest start path and
// ignores the page that was on screen, so the page passes that path in and this route checks it
// is one of ours. A bad value opens the landing page.

export async function GET(req: Request) {
  const start = pwaStartPath(new URL(req.url).searchParams.get("start") ?? "/");
  const icons = [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];
  const body = {
    name: "Accountability",
    short_name: "Accountability",
    display: "standalone",
    id: start,
    start_url: start,
    scope: "/",
    background_color: "#f8f7f4",
    theme_color: "#f8f7f4",
    icons,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-store",
    },
  });
}
