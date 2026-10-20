import Anthropic from "@anthropic-ai/sdk";
import type { FathomTranscript } from "./fathom";

/**
 * Turning a recorded accountability call into one weekly note per person.
 *
 * The meeting is the same shape every week - the two of them walk each other's habits - so the
 * write-up is too, and that makes it a summarization job rather than a judgement one. What the
 * model is *not* allowed to do is invent the agenda: an action item has to map onto a habit the
 * person is actually tracking, which is why each person's habit list is passed in rather than
 * left to the transcript. Everything else that comes up on a call - favours, side projects,
 * scheduling - can colour the headline but can't become an action item, because a note that
 * collects stray to-dos stops being the record of a habit review.
 */

export interface MeetingPerson {
  /** URL path segment / Redis namespace, e.g. "alan". */
  userId: string;
  /** Display name as it's spoken on the call, e.g. "Alan". */
  label: string;
  /** The habits this person tracks, as "🏋️ Gym (1x/week)" lines. */
  habits: string[];
}

export interface MeetingSummary {
  userId: string;
  headline: string;
  wentWell: string[];
  didntGoWell: string[];
  actionItems: string[];
}

const MODEL = "claude-opus-5";

// The app itself is one of the two people's responsibility, so a bug raised on the call is work
// for them rather than a shared note - without this the model files "fix the streak maths" under
// whoever happened to complain about it.
const APP_OWNER_ID = "claude";

const SYSTEM = `You are writing up a weekly accountability meeting between two people who track
habits in a shared app. Each week they go over each other's habits in turn and hold each other to
them. You are given the call transcript and, for each person, the exact list of habits they
currently track.

Write one summary per person, with a headline, what went well, what did not go well, and action
items. Keep every bullet to one short sentence, in the plainest words that still say something
specific - "missed the gym twice, both times after a late night" rather than "struggled with
consistency". The headline names the week's actual story for that person in about ten words - it
has to read as one line on a card, so it can't carry the whole summary.

Action items are the part to be strict about:
- Every action item must map to one of that person's tracked habits, listed below. Cross-check it
  against the list before you write it.
- Exclude everything else the call covered - personal favours, side projects, logistics, other
  business - even when it sounds actionable. It can inform the headline or the context, but it
  must not appear as an action item.
- An action item must be specific and new: a change to how they'll do the habit, a number, a time,
  a named obstacle they'll remove. "Keep going to the gym" is not an action item.
- Anything about the app itself - a bug, a missing feature, a change to how tracking works -
  belongs to the person whose userId is "${APP_OWNER_ID}", whoever raised it.
- If a person genuinely has no specific, habit-linked commitment from this call, return an empty
  list rather than padding it.

Only use what was actually said. Don't infer a habit went well because it wasn't mentioned - if
the call didn't cover it, leave it out.`;

const SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      description: "One entry per person, in the order they were given.",
      items: {
        type: "object",
        properties: {
          userId: { type: "string", description: "The userId of the person this summary is about." },
          headline: { type: "string", description: "About ten words naming this person's week." },
          wentWell: { type: "array", items: { type: "string" } },
          didntGoWell: { type: "array", items: { type: "string" } },
          actionItems: {
            type: "array",
            items: { type: "string" },
            description: "Specific commitments, each mapping to one of this person's tracked habits.",
          },
        },
        required: ["userId", "headline", "wentWell", "didntGoWell", "actionItems"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
} as const;

function buildUserPrompt(transcript: FathomTranscript, people: MeetingPerson[]): string {
  const roster = people
    .map(
      (p) =>
        `${p.label} (userId: ${p.userId}) tracks:\n${
          p.habits.length > 0 ? p.habits.map((h) => `  - ${h}`).join("\n") : "  - (no habits tracked)"
        }`
    )
    .join("\n\n");

  // Fathom labels the account holder by name and everyone else as "Speaker 2", "Speaker 3" and so
  // on, so saying who the unnamed speaker is saves the model guessing from context.
  const names = people.map((p) => p.label).join(" and ");

  return `The call is between ${names}. Fathom only names the speaker whose account recorded it;
any "Speaker 2" / "Speaker 3" line is the other participant.

${roster}

Call: ${transcript.title}${transcript.startedAt ? ` (${transcript.startedAt.slice(0, 10)})` : ""}

Transcript:
${transcript.text}`;
}

export async function summarizeMeeting(
  transcript: FathomTranscript,
  people: MeetingPerson[]
): Promise<MeetingSummary[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  // Streamed because a half-hour transcript plus thinking can run well past the point where a
  // single non-streaming request risks an HTTP timeout; the reply itself is small.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      // Medium rather than the default: the hard part is following the action-item rule, not
      // reasoning its way to an answer, and the whole call has to finish inside one serverless
      // function's lifetime.
      effort: "medium",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserPrompt(transcript, people) }],
  });

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Couldn't summarize that call.");
  }

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  let parsed: { people?: MeetingSummary[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Couldn't read the summary back.");
  }

  // One summary per person we asked about, in the order we asked - a model that drops someone or
  // invents a third userId would otherwise write a note under a namespace nobody reads.
  const byId = new Map((parsed.people ?? []).map((s) => [s.userId, s]));
  return people.map((p) => {
    const s = byId.get(p.userId);
    return {
      userId: p.userId,
      headline: s?.headline?.trim() || `${p.label}'s week`,
      wentWell: clean(s?.wentWell),
      didntGoWell: clean(s?.didntGoWell),
      actionItems: clean(s?.actionItems),
    };
  });
}

const clean = (items?: string[]): string[] =>
  (items ?? []).map((s) => String(s).trim()).filter(Boolean);
