/**
 * Reading a Fathom call transcript from a share link.
 *
 * A Fathom share page is an Inertia.js app: the whole page state is one escaped JSON blob in a
 * `data-page` attribute on the root div. The piece we want is `props.copyTranscriptUrl`, which is
 * the URL behind the page's own "copy transcript" button and already carries the share token as a
 * query parameter. Fetching that returns the transcript as JSON.
 *
 * **The token is what makes this work without credentials.** The same `copy_transcript` endpoint
 * without `?token=` answers 401, so there is no API key to hold and nothing to log in to - the
 * share link a person pastes in is the entire authorization. The flip side is that a revoked or
 * expired link fails at the fetch rather than anywhere we can check up front.
 */

export interface FathomTranscript {
  /** The call's own title, e.g. "Weekly Sync - October 19". */
  title: string;
  /** ISO timestamp the call started, when the page reports one. */
  startedAt?: string;
  /** Speaker-labelled transcript, one `MM:SS - Name` line per turn. */
  text: string;
}

const SHARE_RE = /^https:\/\/fathom\.video\/share\/[A-Za-z0-9_-]+\/?$/;

export function isFathomShareUrl(url: string): boolean {
  return SHARE_RE.test(url.trim());
}

/** The `data-page` attribute is HTML-escaped, and JSON is full of quotes, so this is load-bearing. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface InertiaPage {
  props?: {
    copyTranscriptUrl?: string;
    call?: { title?: string; started_at?: string };
  };
}

export async function fetchFathomTranscript(shareUrl: string): Promise<FathomTranscript> {
  const url = shareUrl.trim();
  if (!isFathomShareUrl(url)) {
    throw new Error("That doesn't look like a Fathom share link.");
  }

  const pageRes = await fetch(url, { redirect: "follow" });
  if (!pageRes.ok) {
    throw new Error("Couldn't open that Fathom link - check it's still shared.");
  }
  const html = await pageRes.text();

  const match = html.match(/data-page="([^"]+)"/);
  if (!match) throw new Error("Couldn't read the Fathom page.");

  let page: InertiaPage;
  try {
    page = JSON.parse(unescapeHtml(match[1]));
  } catch {
    throw new Error("Couldn't read the Fathom page.");
  }

  const transcriptUrl = page.props?.copyTranscriptUrl;
  if (!transcriptUrl) {
    throw new Error("That call has no transcript to read.");
  }

  const transcriptRes = await fetch(transcriptUrl);
  if (!transcriptRes.ok) {
    throw new Error("Couldn't download the transcript.");
  }
  // `plain_text` is the same transcript as `html` with the timestamp links and markup stripped,
  // which is what we want to hand a model - the HTML is five times the tokens for no extra
  // meaning. It's been present on every call we've read, but the strip is cheap insurance.
  const payload = (await transcriptRes.json()) as { plain_text?: string; html?: string };
  const text = (payload.plain_text ?? stripHtml(payload.html ?? "")).trim();
  if (!text) throw new Error("That call's transcript is empty.");

  return {
    title: page.props?.call?.title ?? "Call",
    startedAt: page.props?.call?.started_at,
    text,
  };
}

function stripHtml(html: string): string {
  return unescapeHtml(
    html
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<\/p>/g, "\n")
      .replace(/<[^>]+>/g, "")
  ).replace(/\n{3,}/g, "\n\n");
}
