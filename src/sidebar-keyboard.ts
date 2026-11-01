/** Keep sidebar input away from Tabby's document-level terminal hotkeys. */
export function isolateSidebarKeyboard (host: HTMLElement): () => void {
  const stop = (event: Event): void => event.stopPropagation()
  const focus = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const target = event.target as Element | null
    const control = target?.closest<HTMLElement>('input, textarea, select, button, a[href], summary, [tabindex], [contenteditable]:not([contenteditable="false"])')
    // Selecting plain message text must also move focus out of xterm. Do not
    // cancel the pointer event: native selection and control behavior still run.
    const destination = control && host.contains(control) ? control : host
    if (host.ownerDocument.activeElement !== destination) destination.focus({ preventScroll: true })
  }
  host.tabIndex = -1
  for (const name of ['keydown', 'keypress', 'keyup']) host.addEventListener(name, stop)
  host.addEventListener('pointerdown', focus)
  return () => {
    for (const name of ['keydown', 'keypress', 'keyup']) host.removeEventListener(name, stop)
    host.removeEventListener('pointerdown', focus)
  }
}
