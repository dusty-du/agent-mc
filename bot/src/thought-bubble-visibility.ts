export const DEFAULT_THOUGHT_BUBBLE_HIDE_GRACE_MS = 250;

export interface StickyVisibilityResult {
  hiddenSinceMs: number | null;
  visible: boolean;
}

export function resolveStickyVisibility(
  canRenderNow: boolean,
  nowMs: number,
  hiddenSinceMs: number | null,
  graceMs = DEFAULT_THOUGHT_BUBBLE_HIDE_GRACE_MS
): StickyVisibilityResult {
  if (canRenderNow) {
    return {
      hiddenSinceMs: null,
      visible: true
    };
  }

  const nextHiddenSinceMs = hiddenSinceMs ?? nowMs;
  return {
    hiddenSinceMs: nextHiddenSinceMs,
    visible: nowMs - nextHiddenSinceMs < graceMs
  };
}
