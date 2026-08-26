/**
 * Tracks whether a streaming response has stopped changing across consecutive polls,
 * so adapters only capture a turn once it's actually finished - not the first snapshot
 * that happens to have some text (which, with persisted turn-level dedup, would otherwise
 * permanently lock in a truncated mid-stream capture and never re-check for the real answer).
 */
export class SettleTracker {
  private pending = new Map<string, { lastText: string; stableCount: number }>();

  constructor(private readonly stableThreshold = 2) {}

  /** Call once per poll per turn with its current response text. Returns true once the
   * text has been observed unchanged for `stableThreshold` consecutive calls. */
  isStable(turnKey: string, text: string): boolean {
    const prev = this.pending.get(turnKey);
    if (prev && prev.lastText === text) {
      prev.stableCount++;
      if (prev.stableCount >= this.stableThreshold) {
        this.pending.delete(turnKey);
        return true;
      }
      return false;
    }
    this.pending.set(turnKey, { lastText: text, stableCount: 1 });
    return false;
  }

  clear(turnKey: string): void {
    this.pending.delete(turnKey);
  }
}
