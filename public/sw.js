// Push handler for the installed tracker. It does not cache pages: a habit list has to be
// today's, and a cached shell would show yesterday's check marks.

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function sameOriginUrl(raw) {
  try {
    const url = new URL(raw || "/", self.location.origin);
    if (url.origin !== self.location.origin) return self.location.origin + "/";
    return url.href;
  } catch {
    return self.location.origin + "/";
  }
}

self.addEventListener("push", (event) => {
  let payload = { title: "Still pending", body: "Open the app to check in.", url: "/" };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch {
    // A thrown push handler is a notification the phone never shows.
  }
  const title = typeof payload.title === "string" ? payload.title : "Still pending";
  const body = typeof payload.body === "string" ? payload.body : "Open the app to check in.";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "nudge",
      data: { url: typeof payload.url === "string" ? payload.url : "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = sameOriginUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ("focus" in client) await client.focus();
      if ("navigate" in client) {
        await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
