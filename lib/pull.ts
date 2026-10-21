// The installed app has no reload button, and a pull is the only gesture that loads a new version.
// These numbers are the feel of that gesture: how far a finger has to travel, and when a sideways
// drag stops being a refresh.

export const PULL_THRESHOLD = 72;
export const PULL_MAX = 112;

const ARM = 8;

export function dampenPull(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(PULL_MAX, dy * 0.5);
}

export function isVerticalPull(dx: number, dy: number): boolean {
  return dy > ARM && dy > Math.abs(dx);
}

export function shouldRefresh(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}
