export interface SidebarMount {
  container: HTMLElement
  main: HTMLElement
  wrap: boolean
}

/** Keep the whole Tabby tab area together, including its tab bar. */
export function findSidebarMount (app: HTMLElement | null): SidebarMount | null {
  if (!app) return null
  const windowRoot = app.querySelector(':scope > .window') as HTMLElement | null
  const parent = windowRoot || app
  const content = parent.querySelector(':scope > .content') as HTMLElement | null
  if (!content) return null
  return { container: parent, main: content, wrap: true }
}
