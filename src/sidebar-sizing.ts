export function clampSidebarWidth (width: number, viewportWidth: number): number {
  const maximum = Math.max(220, Math.min(900, viewportWidth - 240))
  return Math.max(220, Math.min(maximum, Math.round(width)))
}
