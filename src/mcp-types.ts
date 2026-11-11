export interface McpClient { id: string; name: string; revision: number; targets: string[]; lastSeen?: string }
export interface McpState { enabled: boolean; running: boolean; port: number; endpoint: string; error: string; clients: McpClient[]; targets: { id: string; title: string; window: number }[]; hostNode?: string; utilityNode?: string }
export interface McpGrant { clientId: string; revision: number; targetId: string; key: string; session: string }
export const MCP_CHANNEL = 'tabby-ai-mcp-v1'
export const emptyMcpState = (): McpState => ({ enabled: false, running: false, port: 0, endpoint: '', error: '', clients: [], targets: [] })
