import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { fakeRedis } from "./redis-fake";
import { isFathomShareUrl, fetchFathomTranscript } from "@/lib/fathom";
import { summarizeMeeting } from "@/lib/meeting-notes";
import { POST } from "@/app/api/meeting-notes/route";
import type { Goal } from "@/lib/types";

// Two halves to this feature, and the seam between them is the only thing worth pinning: reading
// a transcript out of a Fathom share page (a scrape, so it breaks silently when their markup
// moves), and writing the result into *both* people's notes under last week's key.
//
// The summarizer itself is mocked. What it decides belongs in a headline is a judgement call with
// no right answer to assert; what the route does with the answer is not.

vi.mock("@/lib/meeting-notes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meeting-notes")>("@/lib/meeting-notes");
  return {
    ...actual,
    summarizeMeeting: vi.fn(async (_t: unknown, people: { userId: string; label: string; habits: string[] }[]) =>
      people.map((p) => ({
        userId: p.userId,
        headline: `${p.label} ran ${p.habits.length} habits`,
        wentWell: [`${p.label} showed up`],
        didntGoWell: [],
        actionItems: [`${p.label}: do the thing`],
      }))
    ),
  };
});

const NOW = new Date("2026-08-26T19:00:00Z"); // Wed 26 Aug 2026 - so last week is 2026-W34
const LAST_WEEK = "2026-W34";
const SHARE = "https://fathom.video/share/AbC123_-xyz";

const PAGE_JSON = {
  props: {
    copyTranscriptUrl: "https://fathom.video/calls/1/copy_transcript?token=AbC123_-xyz",
    call: { title: "Weekly Sync", started_at: "2026-08-24T18:00:00.000000Z" },
  },
};

/** A Fathom share page: Inertia state in an HTML-escaped `data-page` attribute. */
function sharePage(json: unknown = PAGE_JSON): string {
  const escaped = JSON.stringify(json).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><div id="app" data-page="${escaped}"></div>`;
}

function mockFathom(opts: { page?: string; transcript?: unknown; pageStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/share/")) {
      return new Response(opts.page ?? sharePage(), { status: opts.pageStatus ?? 200 });
    }
    return Response.json(opts.transcript ?? { plain_text: "0:02 - Alan\n  Gym was good.\n" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function goal(over: Partial<Goal> = {}): Goal {
  return { id: "gym", name: "Gym", emoji: "🏋️", frequency: "weekly", targetCount: 1, ...over };
}

async function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/meeting-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  fakeRedis.reset();
  vi.mocked(summarizeMeeting).mockClear();
});

describe("reading a Fathom share link", () => {
  it("only accepts a share URL", () => {
    expect(isFathomShareUrl(SHARE)).toBe(true);
    expect(isFathomShareUrl("https://fathom.video/calls/1")).toBe(false);
    expect(isFathomShareUrl("https://example.com/share/abc")).toBe(false);
    expect(isFathomShareUrl("")).toBe(false);
  });

  it("follows the page's own copy-transcript URL, token and all", async () => {
    const fetchMock = mockFathom();

    const transcript = await fetchFathomTranscript(SHARE);

    expect(transcript.title).toBe("Weekly Sync");
    expect(transcript.text).toContain("Gym was good");
    // The token in that URL is the whole authorization - the same endpoint without it is a 401.
    expect(String(fetchMock.mock.calls[1][0])).toContain("token=AbC123_-xyz");
  });

  // `plain_text` has been on every call we've read, but it's their field, not ours.
  it("falls back to stripping the HTML transcript", async () => {
    mockFathom({ transcript: { html: "<p><b>Alan</b></p><p>Gym was good.</p>" } });

    const transcript = await fetchFathomTranscript(SHARE);

    expect(transcript.text).toContain("Alan");
    expect(transcript.text).not.toContain("<p>");
  });

  it("says so plainly when the page carries no transcript", async () => {
    mockFathom({ page: sharePage({ props: { call: { title: "Weekly Sync" } } }) });

    await expect(fetchFathomTranscript(SHARE)).rejects.toThrow(/no transcript/i);
  });

  it("says so plainly when the link is dead", async () => {
    mockFathom({ pageStatus: 404 });

    await expect(fetchFathomTranscript(SHARE)).rejects.toThrow(/still shared/i);
  });
});

describe("writing the meeting up", () => {
  it("files last week's note in both namespaces", async () => {
    mockFathom();
    fakeRedis.seed("goals", [goal()]);
    fakeRedis.seed("claude:goals", [goal({ id: "piano", name: "Piano" })]);

    const res = await post({ url: SHARE });

    expect(res.status).toBe(200);
    expect((await res.json()).week).toBe(LAST_WEEK);
    // Alan's namespace is the un-prefixed one; Claude's is prefixed. Each gets its own summary,
    // not a shared one.
    const alan = await fakeRedis.get<{ headline: string; weekLabel: string }>(`note:${LAST_WEEK}`);
    const claude = await fakeRedis.get<{ headline: string; weekLabel: string }>(`claude:note:${LAST_WEEK}`);
    expect(alan?.headline).toMatch(/^Alan ran/);
    expect(claude?.headline).toBe("Claude ran 1 habits");
    expect(alan?.weekLabel).toBe("Week of Aug 17");
    expect(claude?.weekLabel).toBe("Week of Aug 17");
  });

  // The action-item rule is "only habits this person tracks", so the lists are what makes it
  // enforceable - a summarizer handed nothing would have nothing to check against.
  it("hands the summarizer each person's own habit list", async () => {
    mockFathom();
    fakeRedis.seed("goals", [goal(), goal({ id: "old", name: "Old", graduatedAt: "2026-01-01" })]);
    fakeRedis.seed("claude:goals", [goal({ id: "piano", name: "Piano", emoji: "🎹", targetCount: 3 })]);

    await post({ url: SHARE });

    const people = vi.mocked(summarizeMeeting).mock.calls[0][1];
    expect(people.map((p) => p.userId)).toEqual(["alan", "claude"]);
    expect(people[0].habits).toContain("🏋️ Gym (1x/week)");
    // A graduated habit isn't tracked any more, so an action item can't be about it.
    expect(people[0].habits.join()).not.toContain("Old");
    expect(people[1].habits).toContain("🎹 Piano (3x/week)");
  });

  it("refuses an empty link without calling out to anything", async () => {
    const fetchMock = mockFathom();

    const res = await post({ url: "   " });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summarizeMeeting).not.toHaveBeenCalled();
  });

  // A dead link, a call with no transcript, a reply that won't parse - all things the person who
  // pasted the link can act on, so the message has to reach them rather than becoming a 500.
  it("returns the reason a link failed, and writes nothing", async () => {
    mockFathom({ pageStatus: 404 });
    fakeRedis.seed("goals", [goal()]);

    const res = await post({ url: SHARE });

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/still shared/i);
    expect(await fakeRedis.get(`note:${LAST_WEEK}`)).toBeNull();
  });
});
