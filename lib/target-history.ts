import type { TargetChange } from "./types";

// Pure geometry and formatting for the "target over time" chart. Kept out of lib/kv.ts so the
// step-line maths can be tested without Redis, and out of the component so the component is only
// SVG.

const DAY_MS = 86_400_000;

function toMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

export function shiftDate(date: string, days: number): string {
  return fromMs(toMs(date) + days * DAY_MS);
}

/**
 * Times per week a target works out to. Daily and weekly targets have to share one axis, and
 * per-week is the only unit both convert into cleanly: moving Salad from 6x/week to daily is an
 * increase (6 → 7), which plotting raw targetCount would draw as a collapse from 6 to 1.
 */
export function weeklyEquivalent(target: Pick<TargetChange, "frequency" | "targetCount">): number {
  return target.frequency === "daily" ? target.targetCount * 7 : target.targetCount;
}

export function formatTarget(target: Pick<TargetChange, "frequency" | "targetCount">): string {
  return `${target.targetCount}x/${target.frequency === "daily" ? "day" : "week"}`;
}

export function sameTarget(
  a: Pick<TargetChange, "frequency" | "targetCount">,
  b: Pick<TargetChange, "frequency" | "targetCount">
): boolean {
  return a.frequency === b.frequency && a.targetCount === b.targetCount;
}

export interface TargetSegment {
  start: string;      // YYYY-MM-DD this target took effect (clamped to the chart's domain)
  end: string;        // YYYY-MM-DD it stopped applying, or today for the current target
  frequency: "daily" | "weekly";
  targetCount: number;
  perWeek: number;
  label: string;
}

export interface TargetStep {
  date: string;
  from: TargetSegment;
  to: TargetSegment;
  direction: "up" | "down";
}

export interface TargetTrend {
  segments: TargetSegment[];
  steps: TargetStep[];
  domainStart: string;
  domainEnd: string;
  /** The first segment has no known start date, so the chart draws it running off the left edge. */
  openStart: boolean;
  minPerWeek: number;
  maxPerWeek: number;
}

// How much empty runway to leave before the first change, so the first step reads as a step
// rather than as the line starting part-way up the axis.
const LEAD_IN_DAYS = 14;

/**
 * Collapse a raw record list into the step line to draw, or null when there's no trend to show -
 * a habit whose target never moved is a flat line, which is just noise on the card.
 *
 * Records with the same date collapse to the last one written that day: changing 3x → 4x → 3x in
 * one sitting is not two steps, it's no change at all, and drawing zero-width segments for it
 * would be a lie about a day the user never actually spent at 4x.
 */
export function buildTargetTrend(changes: TargetChange[], today: string): TargetTrend | null {
  const ordered = [...changes].sort((a, b) => (a.date === b.date ? a.at - b.at : a.date < b.date ? -1 : 1));

  const perDate: TargetChange[] = [];
  for (const change of ordered) {
    const prev = perDate[perDate.length - 1];
    // A backfilled record shares its date with the change that revealed it but describes the run
    // *before* it, so it's never the loser of a same-day collapse - dropping it would leave the
    // first change with nothing to step down from, which is every habit older than this feature.
    if (prev && prev.date === change.date && prev.origin !== "backfilled") perDate.pop();
    perDate.push(change);
  }

  const distinct: TargetChange[] = [];
  for (const change of perDate) {
    if (distinct.length > 0 && sameTarget(distinct[distinct.length - 1], change)) continue;
    distinct.push(change);
  }

  if (distinct.length < 2) return null; // never changed - nothing to trend

  const first = distinct[0];
  const openStart = first.origin !== "created";
  const domainStart = openStart ? shiftDate(distinct[1].date, -LEAD_IN_DAYS) : first.date;
  const domainEnd = today;

  const segments: TargetSegment[] = distinct.map((change, i) => {
    const next = distinct[i + 1];
    return {
      start: i === 0 ? domainStart : change.date,
      end: next ? next.date : domainEnd,
      frequency: change.frequency,
      targetCount: change.targetCount,
      perWeek: weeklyEquivalent(change),
      label: formatTarget(change),
    };
  });

  // A reshape that lands on the same per-week level (7x/week → 1x/day) counts as "up": it's a
  // tightening - every day now has to carry one - even though the weekly total is unchanged.
  const steps: TargetStep[] = segments.slice(1).map((segment, i) => ({
    date: segment.start,
    from: segments[i],
    to: segment,
    direction: segment.perWeek >= segments[i].perWeek ? "up" : "down",
  }));

  const levels = segments.map((s) => s.perWeek);
  return {
    segments,
    steps,
    domainStart,
    domainEnd,
    openStart,
    minPerWeek: Math.min(...levels),
    maxPerWeek: Math.max(...levels),
  };
}

/**
 * The distinct y levels to label, each carrying the most recent wording used at that level - two
 * targets can land on the same per-week level (7x/week and 1x/day) and the newer one is the one
 * worth showing.
 */
export function targetLevels(trend: TargetTrend): { perWeek: number; label: string }[] {
  const byLevel = new Map<number, string>();
  for (const segment of trend.segments) byLevel.set(segment.perWeek, segment.label);
  return Array.from(byLevel, ([perWeek, label]) => ({ perWeek, label }))
    .sort((a, b) => a.perWeek - b.perWeek);
}

/** Month boundaries inside the domain, for the x-axis ticks. */
export function monthTicks(trend: TargetTrend): { date: string; label: string }[] {
  const ticks: { date: string; label: string }[] = [];
  const [sy, sm] = trend.domainStart.split("-").map(Number);
  for (let i = 0; i < 60; i++) {
    const date = fromMs(Date.UTC(sy, sm - 1 + i, 1));
    if (date < trend.domainStart) continue;
    if (date > trend.domainEnd) break;
    ticks.push({
      date,
      label: new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
    });
  }
  return ticks;
}
