export type McpMode = 'read_only' | 'confirm' | 'auto'
export interface McpClient { id: string; name: string; revision: number; mode?: McpMode; targets: string[]; lastSeen?: string }
export interface McpApproval { id: string; client: string; target: string; title: string; window: number; tool: string; input: string; expiresAt: number }
export interface McpLease { id: string; clientId: string; revision: number; targetId: string; key: string; session: string; expiresAt: number }
export interface McpState { discovery?: { registry: string; skillInstallations: { path: string; status: string }[]; error: string }; approvals?: McpApproval[]; leases?: { id: string; client: string; target: string; title: string; window: number; expiresAt: number }[]; enabled: boolean; running: boolean; port: number; endpoint: string; error: string; clients: McpClient[]; targets: { id: string; title: string; window: number }[]; hostNode?: string; utilityNode?: string }
export interface McpGrant { mode?: McpMode; clientId: string; revision: number; targetId: string; key: string; session: string }
export const MCP_CHANNEL = 'tabby-ai-mcp-v1'
export const emptyMcpState = (): McpState => ({ enabled: false, running: false, port: 0, endpoint: '', error: '', clients: [], targets: [] })
