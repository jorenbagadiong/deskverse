/**
 * Frame time to use for easing in an on-demand ("demand") render loop.
 *
 * - After the scene has been idle, the first frame's delta covers the whole
 *   idle period (seconds). Treat that as a single 60 fps frame so transitions
 *   start smoothly instead of jumping to the end.
 * - Otherwise use the real frame time (capped at 100 ms), so animations keep
 *   real-time speed on slow GPUs instead of running in slow motion.
 */
export function frameDelta(rawDelta: number): number {
  if (rawDelta > 0.25) return 1 / 60
  return Math.min(rawDelta, 0.1)
}
