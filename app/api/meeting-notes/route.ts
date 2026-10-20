import { NextResponse } from "next/server";
import { withPerf } from "@/lib/perf";
import {
  getGoals,
  getLatestNoteWeekKey,
  getWeekLabel,
  getUsers,
  resolveUser,
  saveWeeklyNote,
} from "@/lib/kv";
import { fetchFathomTranscript } from "@/lib/fathom";
import { summarizeMeeting, type MeetingPerson } from "@/lib/meeting-notes";
import type { Goal } from "@/lib/types";

/**
 * Paste a Fathom share link, get last week's meeting note written for both people.
 *
 * The meeting is always the same two people reviewing each other, so the pair is fixed here
 * rather than passed in - there is no third participant to disambiguate, and asking the caller
 * which namespaces to write to would only be a way to write the note into the wrong one.
 *
 * It writes immediately, with no preview step: the note is editable from the notes tab the moment
 * it lands, so a review screen would only be a slower route to the same edit.
 */

const PAIR = ["alan", "claude"];

// Reading a half-hour transcript and summarizing it twice doesn't fit in a default function
// lifetime. Same reason `app/api/coach` raises its own.
export const maxDuration = 120;

/** How a habit reads on the history page - the list the action items are checked against. */
function habitLine(goal: Goal): string {
  const unit = goal.frequency === "daily" ? "x/day" : "x/week";
  return `${goal.emoji} ${goal.name} (${goal.targetCount}${unit})`;
}

async function POSTHandler(req: Request) {
  const { url } = await req.json();
  if (typeof url !== "string" || !url.trim()) {
    return NextResponse.json({ error: "Paste a Fathom share link." }, { status: 400 });
  }

  const [users, transcript] = await Promise.all([getUsers(), fetchFathomTranscript(url)]);

  const people: MeetingPerson[] = await Promise.all(
    PAIR.map(async (id) => {
      const goals = await getGoals(resolveUser(id));
      return {
        userId: id,
        label: users.find((u) => u.id === id)?.label ?? id,
        habits: goals.filter((g) => !g.graduatedAt).map(habitLine),
      };
    })
  );

  const summaries = await summarizeMeeting(transcript, people);

  const week = getLatestNoteWeekKey();
  const weekLabel = getWeekLabel(week);
  await Promise.all(
    summaries.map((s) =>
      saveWeeklyNote(
        {
          week,
          weekLabel,
          headline: s.headline,
          wentWell: s.wentWell,
          didntGoWell: s.didntGoWell,
          actionItems: s.actionItems,
        },
        resolveUser(s.userId)
      )
    )
  );

  return NextResponse.json({ week, weekLabel, summaries });
}

export const POST = withPerf("POST /api/meeting-notes", async (req: Request) => {
  try {
    return await POSTHandler(req);
  } catch (e) {
    // Every failure here is a message the user needs to read - a dead link, a call with no
    // transcript, a summary that came back unparseable - so they surface as text rather than a
    // 500 the notes tab can only render as "something went wrong".
    const message = e instanceof Error ? e.message : "Couldn't write the notes.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
