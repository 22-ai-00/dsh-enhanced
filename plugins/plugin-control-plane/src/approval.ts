import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import type { ApprovalAuthority, ApprovalReceipt, PluginActivationPlan, PluginSourcePlan, VerifiedApprovalReceipt } from './types.js'
import { ControlPlaneStoreError } from './store.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const DIGEST = /^[a-f0-9]{64}$/u

function canonicalReceipt(receipt: ApprovalReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    approvalId: receipt.approvalId,
    authority: receipt.authority,
    keyId: receipt.keyId,
    planId: receipt.planId,
    planDigest: receipt.planDigest,
    decision: receipt.decision,
    principal: receipt.principal.normalize('NFC').trim(),
    decidedAt: receipt.decidedAt,
    expiresAt: receipt.expiresAt,
  })
}

export function parseApprovalReceipt(value: unknown): ApprovalReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ControlPlaneStoreError('invalid-input', 'approval receipt must be an object')
  const item = value as Partial<ApprovalReceipt>
  if (item.schemaVersion !== 1 || typeof item.approvalId !== 'string' || typeof item.authority !== 'string'
    || typeof item.keyId !== 'string' || typeof item.planId !== 'string' || typeof item.planDigest !== 'string'
    || (item.decision !== 'approved' && item.decision !== 'rejected') || typeof item.principal !== 'string'
    || !Number.isSafeInteger(item.decidedAt) || !Number.isSafeInteger(item.expiresAt) || typeof item.signature !== 'string') {
    throw new ControlPlaneStoreError('invalid-input', 'approval receipt fields are invalid')
  }
  if (![item.approvalId, item.authority, item.keyId, item.planId].every(value => ID.test(value))
    || !DIGEST.test(item.planDigest) || item.principal.trim() === '' || item.principal.length > 256
    || item.expiresAt! <= item.decidedAt! || !/^[A-Za-z0-9+/]+={0,2}$/u.test(item.signature)) {
    throw new ControlPlaneStoreError('invalid-input', 'approval receipt values are invalid')
  }
  return item as ApprovalReceipt
}

export class Ed25519ApprovalAuthority implements ApprovalAuthority {
  constructor(
    readonly publicKey: string | Buffer,
    readonly expectedAuthority: string,
    readonly expectedKeyId: string,
    readonly now: () => number = Date.now,
  ) {}

  async verify(receiptInput: ApprovalReceipt, plan: Pick<PluginActivationPlan | PluginSourcePlan, 'id' | 'digest' | 'createdAt' | 'expiresAt'>): Promise<VerifiedApprovalReceipt> {
    const receipt = parseApprovalReceipt(receiptInput)
    if (receipt.authority !== this.expectedAuthority || receipt.keyId !== this.expectedKeyId
      || receipt.planId !== plan.id || receipt.planDigest !== plan.digest) {
      throw new ControlPlaneStoreError('conflict', 'approval receipt is not bound to this exact authority, key, plan, and digest')
    }
    if (receipt.decidedAt < plan.createdAt || receipt.decidedAt > plan.expiresAt || this.now() > receipt.expiresAt) {
      throw new ControlPlaneStoreError('expired', 'approval receipt is outside its valid plan-bound interval')
    }
    const body = Buffer.from(canonicalReceipt(receipt))
    const signature = Buffer.from(receipt.signature, 'base64')
    if (!verify(null, body, createPublicKey(this.publicKey), signature)) {
      throw new ControlPlaneStoreError('invalid-input', 'approval receipt signature is invalid')
    }
    const { signature: _signature, ...fields } = receipt
    return { ...fields, principal: fields.principal.normalize('NFC').trim(), signatureDigest: createHash('sha256').update(signature).digest('hex') }
  }
}

export async function loadPrivateApprovalInput(path: string, maximumBytes: number): Promise<string> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new ControlPlaneStoreError('invalid-input', 'approval input must be a regular non-symlink file')
  }
  const value = await readFile(path, 'utf8')
  if (Buffer.byteLength(value) > maximumBytes) throw new ControlPlaneStoreError('invalid-input', 'approval input is too large')
  return value
}

export function approvalSigningPayload(receipt: Omit<ApprovalReceipt, 'signature'>): string {
  return canonicalReceipt({ ...receipt, signature: '' })
}
