// Shared by both model backends and the host-side permission check.
export const TABBY_MUTATIONS = new Set([
  'send_input', 'send_keys', 'attach_process', 'interact_tab', 'open_profile', 'manage_profile', 'run_command',
  'open_settings', 'write_config', 'close_tab', 'duplicate_tab', 'rename_tab', 'split_tab', 'layout_tabs',
  'interact_window',
])

const string = { type: 'string' }
const object = { type: 'object', additionalProperties: true }
const tool = (name: string, description: string, properties: Record<string, any> = {}, required: string[] = []) => ({
  type: 'function', name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
})

export const TABBY_OPERATIONS = [
  tool('get_capabilities', 'Discover live Tabby capability providers and available tools. Use before a new kind of Tabby task; installed providers and commands are authoritative.'),
  tool('read_skill', 'Read bundled Tabby skill or operation reference. section=upstream lists official source paths; add source to read one path. Upstream documentation is not proof of installed features.', { section: { type: 'string', enum: ['overview', 'operations', 'upstream'] }, source: string }),
  tool('list_profiles', 'List built-in and saved connection profiles without exposing credentials. Includes local shells, SSH, serial, Telnet and plugin providers when installed.'),
  tool('get_profile', 'Read a profile with credential fields redacted.', { profileId: string }, ['profileId']),
  tool('open_profile', 'Open a discovered connection profile in a new Tabby tab. Authentication may require user interaction.', { profileId: string }, ['profileId']),
  tool('manage_profile', 'Create, update or delete a saved profile. Supply only intended fields in profile; update preserves other options. Discover provider IDs first. Credential fields should be entered by the user in Settings.', { action: { type: 'string', enum: ['create', 'update', 'delete'] }, profileId: string, profile: object }, ['action']),
  tool('list_commands', 'Discover current registered Tabby and plugin commands, including context-menu commands. Supply tabId for commands on that pane. Returned command IDs are valid for this context; commands without native IDs also receive callable IDs.', { tabId: string }),
  tool('run_command', 'Execute a command returned by list_commands in the same tab context. May open dialogs; inspect tabs afterward. A completed dispatch does not prove the requested task finished.', { commandId: string, tabId: string }, ['commandId']),
  tool('get_command_result', 'Check a dispatched Tabby command operation. If pending, inspect read_window for a dialog instead of dispatching the command again.', { operationId: string }, ['operationId']),
  tool('list_hotkeys', 'List installed Tabby hotkey descriptions and bindings. Use registered commands or UI for execution, not synthetic key events.'),
  tool('read_window', 'Inspect visible Tabby application controls and text, prioritizing the topmost application dialog. Use when a command opens a modal outside a tab. OS-native dialogs are not accessible.'),
  tool('interact_window', 'Operate a visible application control discovered by read_window. The active dialog must still match. OS-native dialogs require user interaction.', { controlId: string, action: { type: 'string', enum: ['click', 'set_value'] }, value: string }, ['controlId', 'action']),
  tool('open_settings', 'Open Tabby Settings. page is an installed SettingsTabProvider ID; omit for the settings home. Read the tab to discover settings controls.', { page: string }),
  tool('read_config', 'Read a specific configuration path with secrets redacted. Dot-separated path, for example terminal.fontSize or hotkeys. Never reads the vault or AI credentials.', { path: string }, ['path']),
  tool('write_config', 'Set one existing configuration path and persist it, for example terminal.fontSize. value must contain a value key with the desired JSON value. Read it first; some settings need restart. Use profile tools for profiles and Settings UI for plugin/vault/AI permissions.', { path: string, value: object }, ['path', 'value']),
  tool('close_tab', 'Close the target pane using Tabby close checks; may require a Tabby confirmation dialog. Re-list tabs to verify closure.', { tabId: string }, ['tabId']),
  tool('duplicate_tab', 'Duplicate a pane using its provider recovery support.', { tabId: string }, ['tabId']),
  tool('rename_tab', 'Set a custom title on a tab or pane.', { tabId: string, title: string }, ['tabId', 'title']),
  tool('split_tab', 'Duplicate a pane into a split to the right, left, top or bottom. Provider must support recovery.', { tabId: string, direction: { type: 'string', enum: ['r', 'l', 't', 'b'] } }, ['tabId', 'direction']),
  tool('layout_tabs', 'Equalize panes, maximize/restore one pane, or explode a split group into separate tabs.', { tabId: string, action: { type: 'string', enum: ['equalize', 'maximize', 'restore', 'explode'] } }, ['tabId', 'action']),
]
