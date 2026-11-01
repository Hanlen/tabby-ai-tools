/** Keep sidebar input away from Tabby's document-level terminal hotkeys. */
export function isolateSidebarKeyboard (host: HTMLElement): () => void {
  const stop = (event: Event): void => event.stopPropagation()
  const focus = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    const control = target?.closest<HTMLElement>('input, textarea, select, button, a[href], summary, [tabindex], [contenteditable]:not([contenteditable="false"])')
    // Let the browser focus controls during the pointer event's default action.
    // Calling focus() early can carry :focus-visible from the prompt to a clicked
    // button, leaving a keyboard focus ring on History, Context and other controls.
    if (control && control !== host && host.contains(control)) return
    // Plain text outside a focusable container still needs focus out of xterm.
    // Keep the default action so native text selection and copying remain intact.
    if (host.ownerDocument.activeElement !== host) host.focus({ preventScroll: true })
  }
  host.tabIndex = -1
  for (const name of ['keydown', 'keypress', 'keyup']) host.addEventListener(name, stop)
  host.addEventListener('pointerdown', focus)
  return () => {
    for (const name of ['keydown', 'keypress', 'keyup']) host.removeEventListener(name, stop)
    host.removeEventListener('pointerdown', focus)
  }
}
