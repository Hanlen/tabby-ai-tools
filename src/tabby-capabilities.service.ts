import { Injectable, Injector } from '@angular/core'
import { AppService, BaseTabComponent, Command, CommandProvider, ConfigService, HotkeysService, ProfilesService, TabContextMenuItemProvider, ToolbarButtonProvider, MenuItemOptions } from 'tabby-core'
import { SettingsTabComponent, SettingsTabProvider } from 'tabby-settings'
const knowledge: typeof import('./tabby-knowledge.json') = require('./tabby-knowledge.json')
import { TAB_TOOLS } from './tab-tool-definitions'

const secret = /password|passphrase|secret|token|private.?key|credential|authorization|api.?key|^env$|^environment$|^scripts$|^loginScripts$/i
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])

function safeObject (value: any): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw new Error('Unsafe property name')
    safeObject(child)
  }
}

export function redactTabbyValue (value: any): any {
  if (Array.isArray(value)) return value.map(redactTabbyValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('__')).map(([key, child]) => [key, secret.test(key) ? '[redacted]' : redactTabbyValue(child)]))
  return value
}

@Injectable()
export class TabbyCapabilitiesService {
  private discovered = new Map<string, { command: Command; tab?: BaseTabComponent }>()
  private commandSequence = 0
  private operationSequence = 0
  private operations = new Map<string, { status: 'pending' | 'completed' | 'failed'; error?: string; key: string; tab?: BaseTabComponent }>()

  constructor (private app: AppService, private profiles: ProfilesService, private injector: Injector,
    private hotkeys: HotkeysService, private config: ConfigService) {}

  // CommandService is not exported by tabby-core. Discover through the public
  // provider tokens, using the same toolbar/context-menu/command routes as Tabby.
  private async commands (tab?: BaseTabComponent): Promise<Command[]> {
    const enabled = <T extends object>(token: any): T[] => this.config.enabledServices(this.injector.get(token, []) as T[])
    const commands: Command[] = []
    for (const provider of enabled<ToolbarButtonProvider>(ToolbarButtonProvider)) commands.push(...provider.provide().map(button => Command.fromToolbarButton(button)))
    const flatten = (item: MenuItemOptions, prefix = '') => {
      if (item.enabled === false || item.type === 'separator') return
      const label = `${prefix}${item.commandLabel || item.label || ''}`
      if (item.submenu) item.submenu.forEach(child => flatten(child, `${label} > `))
      else commands.push(Command.fromMenuItem({ ...item, label, commandLabel: label }))
    }
    if (tab) for (const provider of enabled<TabContextMenuItemProvider>(TabContextMenuItemProvider)) {
      for (const target of Array.from(new Set([tab.topmostParent || tab, tab]))) {
        for (const header of [false, true]) for (const item of await provider.getItems(target, header)) flatten(item)
      }
    }
    for (const provider of enabled<CommandProvider>(CommandProvider)) commands.push(...await provider.provide({ tab }))
    const blacklist: string[] = this.config.store.commandBlacklist || []
    const seen = new Set<string>()
    return commands.filter(command => {
      if (command.id && blacklist.includes(command.id)) return false
      const key = command.id || JSON.stringify([command.label, command.sublabel])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private async profile (id: string): Promise<any> {
    const profile = (await this.profiles.getProfiles({ clone: true })).find(p => p.id === id)
    if (!profile) throw new Error('Profile no longer exists; call list_profiles again')
    return profile
  }

  private configTarget (path: unknown): { parent: any; key: string } {
    if (typeof path !== 'string' || !path || path.length > 300) throw new Error('A configuration path is required')
    const parts = path.split('.')
    if (parts.some(part => !part || forbidden.has(part) || part.startsWith('__') || secret.test(part)) ||
      ['codexAgent', 'vault', 'profiles', 'profileDefaults', 'groups', 'configSync', 'pluginBlacklist', 'pluginManager'].includes(parts[0])) throw new Error('Use the dedicated profile tools or Settings UI for this configuration')
    let parent = this.config.store
    for (const part of parts.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !(part in parent)) throw new Error('Configuration path does not exist')
      parent = parent[part]
    }
    const key = parts[parts.length - 1]
    if (!parent || typeof parent !== 'object' || !(key in parent)) throw new Error('Configuration path does not exist')
    return { parent, key }
  }

  async call (name: string, args: any, tab: BaseTabComponent | undefined, checkStopped: () => void): Promise<any> {
    safeObject(args)
    if (name === 'read_skill') {
      if (!args.section || args.section === 'overview') return { text: knowledge.skill, upstreamCommit: knowledge.upstream.commit }
      if (args.section === 'operations') return { text: knowledge.operations }
      if (args.section === 'upstream') {
        if (args.source) {
          const source = knowledge.upstream.sources.find(source => source.path === args.source)
          if (!source) throw new Error('Unknown official source; list sources with section=upstream first')
          return source
        }
        return { ...knowledge.upstream, sources: knowledge.upstream.sources.map(({ path, url, sha256 }) => ({ path, url, sha256 })) }
      }
      throw new Error('Unknown skill section')
    }
    if (name === 'get_capabilities') return {
      tools: TAB_TOOLS.flatMap(namespace => namespace.tools.map(tool => tool.name)),
      profileProviders: this.profiles.getProviders().map(p => ({ id: p.id, name: p.name })),
      settingsPages: this.config.enabledServices(this.injector.get(SettingsTabProvider, []) as SettingsTabProvider[]).map(p => ({ id: p.id, title: p.title })),
      upstream: { commit: knowledge.upstream.commit, checkedAt: knowledge.upstream.checkedAt, referenceOnly: true },
      discovery: 'Use list_tabs, list_profiles, list_commands and list_hotkeys for the installed capabilities. SFTP, tunnels, transfers and third-party features depend on installed providers and contextual commands. Settings controls are available through open_settings/read_tab/interact_tab.',
    }
    if (name === 'list_profiles') return (await this.profiles.getProfiles()).map(p => ({ id: p.id, type: p.type, name: p.name, group: p.group, isBuiltin: p.isBuiltin, isTemplate: p.isTemplate }))
    if (name === 'get_profile') return redactTabbyValue(await this.profile(args.profileId))
    if (name === 'open_profile') {
      const profile = await this.profile(args.profileId)
      checkStopped()
      const opened = await this.profiles.openNewTabForProfile(profile)
      return { opened: !!opened, title: opened?.title, next: 'Call list_tabs to obtain the new pane ID and inspect the connection state.' }
    }
    if (name === 'manage_profile') {
      if (!['create', 'update', 'delete'].includes(args.action)) throw new Error('Unknown profile action')
      const current = args.action === 'create' ? undefined : await this.profile(args.profileId)
      if (current?.isBuiltin) throw new Error('Built-in profiles cannot be edited; create a saved profile instead')
      checkStopped()
      if (args.action === 'delete') {
        await this.profiles.deleteProfile(current)
        await this.config.save()
        return { deleted: args.profileId, saved: true }
      }
      const patch = args.profile
      if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new Error('profile must be an object')
      if (patch.options !== undefined && (!patch.options || typeof patch.options !== 'object' || Array.isArray(patch.options))) throw new Error('Profile options must be an object')
      const containsRedaction = (value: any): boolean => value === '[redacted]' || !!value && typeof value === 'object' && Object.values(value).some(containsRedaction)
      if (containsRedaction(patch)) throw new Error('Do not write redacted placeholders; omit unchanged credential fields')
      const allowed = ['type', 'name', 'group', 'options', 'icon', 'color', 'disableDynamicTitle', 'behaviorOnSessionEnd', 'weight']
      for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new Error(`Unsupported profile field: ${key}`)
      const next = { ...current, ...patch, options: { ...current?.options, ...patch.options } }
      if (typeof next.type !== 'string' || typeof next.name !== 'string' || !next.name.trim()) throw new Error('Profile type and name are required')
      if (!this.profiles.getProviders().some(p => p.id === next.type)) throw new Error('Profile provider is not installed')
      if (args.action === 'create') await this.profiles.newProfile(next)
      else await this.profiles.writeProfile(next)
      await this.config.save()
      return { saved: true, next: 'Call list_profiles to verify.' }
    }
    if (name === 'list_commands') {
      const commands = await this.commands(tab)
      checkStopped()
      // Replace only this context's handles, leaving other panes' catalogs usable.
      for (const [id, entry] of this.discovered) if (entry.tab === tab) this.discovered.delete(id)
      return commands.map(command => {
        const id = `command-${++this.commandSequence}`
        this.discovered.set(id, { command, tab })
        return { id, nativeId: command.id, label: command.label, sublabel: command.sublabel }
      })
    }
    if (name === 'get_command_result') {
      const state = this.operations.get(args.operationId)
      if (!state) throw new Error('Unknown command operation ID')
      return { operationId: args.operationId, status: state.status, ...(state.error ? { error: state.error } : {}) }
    }
    if (name === 'run_command') {
      const entry = this.discovered.get(args.commandId)
      if (!entry || entry.tab !== tab) throw new Error('Command is stale or the tab context changed; call list_commands again')
      // Re-discover so removed providers and commands cannot be invoked via stale handles.
      const available = await this.commands(tab)
      const matches = available.filter(c => entry.command.id ? c.id === entry.command.id : !c.id && c.label === entry.command.label && c.sublabel === entry.command.sublabel)
      if (matches.length !== 1) throw new Error('Command is unavailable or ambiguous; call list_commands again')
      checkStopped()
      const key = entry.command.id || JSON.stringify([entry.command.label, entry.command.sublabel])
      if (Array.from(this.operations.values()).some(state => state.status === 'pending' && state.tab === tab && state.key === key)) throw new Error('This command is still pending; inspect read_window and get_command_result')
      const operationId = `operation-${++this.operationSequence}`
      const state: { status: 'pending' | 'completed' | 'failed'; error?: string; key: string; tab?: BaseTabComponent } = { status: 'pending', key, tab }
      this.operations.set(operationId, state)
      const work = Promise.resolve().then(() => matches[0].run()).then(() => { state.status = 'completed' }, error => { state.status = 'failed'; state.error = String(error?.message || error).slice(0, 1000) })
      // Dialog-opening commands may not resolve until the dialog closes. Return
      // control to the model so it can inspect and operate that dialog.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, 100) })])
      if (timer) clearTimeout(timer)
      for (const [id, previous] of this.operations) if (this.operations.size > 100 && previous.status !== 'pending') this.operations.delete(id)
      return { dispatched: true, operationId, status: state.status, ...(state.error ? { error: state.error } : {}), next: 'Inspect read_window/read_tab; check get_command_result after completing any dialog. Do not repeat a pending command.' }
    }
    if (name === 'list_hotkeys') return (await this.hotkeys.getHotkeyDescriptions()).map(h => ({ ...h, bindings: this.config.store.hotkeys?.[h.id] }))
    if (name === 'open_settings') {
      const pages = this.config.enabledServices(this.injector.get(SettingsTabProvider, []) as SettingsTabProvider[])
      if (args.page && !pages.some(p => p.id === args.page)) throw new Error('Settings page is unavailable; call get_capabilities for installed page IDs')
      const settings = this.app.tabs.find(t => t instanceof SettingsTabComponent) as SettingsTabComponent | undefined
      if (settings) {
        if (args.page) settings.activeTab = args.page
        this.app.selectTab(settings)
      } else this.app.openNewTabRaw({ type: SettingsTabComponent, inputs: args.page ? { activeTab: args.page } : {} })
      return { opened: true, next: 'Call list_tabs and read_tab to inspect settings and available controls.' }
    }
    if (name === 'read_config' || name === 'write_config') {
      const { parent, key } = this.configTarget(args.path)
      if (name === 'read_config') return { path: args.path, value: redactTabbyValue(parent[key]) }
      if (!args.path.includes('.')) throw new Error('Write a specific setting path, not an entire configuration section')
      if (!args.value || !Object.prototype.hasOwnProperty.call(args.value, 'value')) throw new Error('value must contain a value key')
      const next = args.value.value
      const previous = parent[key]
      if (previous !== null && (typeof next !== typeof previous || Array.isArray(next) !== Array.isArray(previous))) throw new Error('Configuration value has an incompatible type')
      checkStopped()
      parent[key] = next
      try { await this.config.save() } catch (error) { parent[key] = previous; throw error }
      return { saved: true, path: args.path, value: redactTabbyValue(parent[key]), restartRequested: this.config.restartRequested }
    }
    throw new Error(`Unknown Tabby operation: ${name}`)
  }
}
