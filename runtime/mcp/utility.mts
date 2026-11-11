import { startMcpServer, type Snapshot } from './server.mjs'
import { UtilityRequests } from './utility-rpc.cjs'

const parent = (process as any).parentPort
if (!parent) throw new Error('MCP runtime requires Electron utilityProcess')
let server: Awaited<ReturnType<typeof startMcpServer>> | undefined
let chain = Promise.resolve()
const seen = new Map<string, number>()
const rpc = new UtilityRequests(message => parent.postMessage(message), () => {
  // A broken parent cannot receive results or authorize future observations.
  // Close the listener and let main observe a real exit, without a replay.
  void Promise.resolve().then(() => server?.close()).finally(() => process.exit(1))
})
parent.on('close', () => rpc.close())
parent.on('message', ({ data }: { data: any }) => {
  if (data?.type === 'tool-result') {
    rpc.receive(data); return
  }
  if (data?.type === 'update') {
    server?.update(data.snapshot as Snapshot)
    for (const id of seen.keys()) if (!data.snapshot.clients.some((c: any) => c.id === id)) seen.delete(id)
    return
  }
  chain = chain.then(async () => {
    try {
      let value
      if (data.type === 'start') {
        if (server) throw new Error('MCP is already running')
        server = await startMcpServer((...args) => rpc.invoke(...args), data.snapshot, data.port, id => {
          if (Date.now() - (seen.get(id) || 0) < 1000) return
          seen.set(id, Date.now()); rpc.post({ type: 'activity', clientId: id })
        })
        value = { port: server.port, node: process.versions.node }
      } else if (data.type === 'stop') {
        await server?.close(); server = undefined
      } else throw new Error('Unknown MCP control request')
      rpc.post({ type: 'control-result', id: data.id, value })
    } catch (error: any) { rpc.post({ type: 'control-result', id: data.id, error: error.code || 'MCP runtime failed' }) }
  })
})
