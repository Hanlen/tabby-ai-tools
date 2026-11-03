import { promises as fs, constants } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { TextDecoder } from 'util'

export type AgentInstructions = { mode: 'inherit' | 'none' } | { mode: 'inline'; text: string } | { mode: 'file'; path: string }
export interface InstructionsSnapshot {
  version: 1
  source: string
  text: string
  hash: string
  createdAt: number
  modifiedAt?: number
}
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

export function validateInstructions (value?: AgentInstructions): void {
  if (!value) return
  if (!['inherit', 'none', 'inline', 'file'].includes(value.mode)) throw new Error('Invalid instruction source')
  if (value.mode === 'inline' && (typeof value.text !== 'string' || Buffer.byteLength(value.text) > INSTRUCTIONS_MAX_BYTES)) throw new Error('Custom instructions must be UTF-8 text, at most 32 KiB')
  if (value.mode === 'file' && (typeof value.path !== 'string' || !path.isAbsolute(value.path) || value.path.includes('\0'))) throw new Error('Choose an absolute local instruction file path')
}

export async function resolveInstructions (value?: AgentInstructions, defaults?: AgentInstructions): Promise<InstructionsSnapshot> {
  validateInstructions(value); validateInstructions(defaults)
  const inherited = !value || value.mode === 'inherit'
  const effective = inherited ? defaults : value
  let text = '', source = 'none', modifiedAt: number | undefined
  if (effective?.mode === 'inline') { text = effective.text; source = inherited ? 'default:inline' : 'connection:inline' }
  if (effective?.mode === 'file') {
    source = effective.path
    // stat before open avoids blocking on FIFOs/devices; a bounded read also
    // prevents a file growing after stat from bypassing the size limit.
    const stat = await fs.stat(source)
    if (!stat.isFile()) throw new Error('Instruction source must be a regular local file')
    if (stat.size > INSTRUCTIONS_MAX_BYTES) throw new Error('Instruction file exceeds 32 KiB')
    const file = await fs.open(source, constants.O_RDONLY | (constants.O_NONBLOCK || 0))
    try {
      if (!(await file.stat()).isFile()) throw new Error('Instruction source must be a regular local file')
      const buffer = Buffer.alloc(INSTRUCTIONS_MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, length)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > INSTRUCTIONS_MAX_BYTES) throw new Error('Instruction file exceeds 32 KiB')
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) } catch { throw new Error('Instruction file must be valid UTF-8') }
      modifiedAt = stat.mtimeMs
    } finally { await file.close() }
  }
  text = text.replace(/^\uFEFF/, '')
  return { version: 1, source, text, hash: digest(text), createdAt: Date.now(), ...(modifiedAt === undefined ? {} : { modifiedAt }) }
}

export function validateInstructionsSnapshot (value: InstructionsSnapshot): void {
  if (!value || value.version !== 1 || typeof value.source !== 'string' || typeof value.text !== 'string' || Buffer.byteLength(value.text) > INSTRUCTIONS_MAX_BYTES || value.hash !== digest(value.text) || !Number.isFinite(value.createdAt)) throw new Error('Invalid saved instruction snapshot')
}

export function instructionsText (snapshot?: InstructionsSnapshot): string {
  if (!snapshot) return ''
  validateInstructionsSnapshot(snapshot)
  return snapshot.text ? '\n\nCustom user instructions (Tabby session snapshot):\n' + snapshot.text : ''
}
