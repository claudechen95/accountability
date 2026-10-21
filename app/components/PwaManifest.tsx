"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { pwaStartPath } from "@/lib/pwa";

// The manifest link is added after hydration. Putting a default one in the first HTML would
// install the landing page for someone who saves the app before this runs. If they install
// before hydration, iOS uses the page they are on, which is the right person.
//
// The worker is registered here, including in a Safari tab, so Add to Home Screen picks up a
// worker. The enable button itself waits until the app is standalone, because iOS has no
// PushManager in a tab.

export default function PwaManifest() {
  const pathname = usePathname();

  useEffect(() => {
    const start = pwaStartPath(pathname || "/");
    const href = `/manifest.webmanifest?start=${encodeURIComponent(start)}`;
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "manifest";
      document.head.appendChild(link);
    }
    link.href = href;

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // A failed registration leaves the button able to try again from the click.
      });
    }
  }, [pathname]);

  return null;
}
