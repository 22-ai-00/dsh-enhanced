/** Original source provenance survives a new conversation Session, never owner rotation. */
export interface SourceOwnerReceipt {
  readonly receiptVersion: 2
  readonly authorityId: string
  readonly authorityHash: string
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly agentPreset: string
  readonly bindingVersion: number
  readonly generation: number
}

/** Only a current authenticated route may continue an older source's finite authority.
 * This does not renew a grant, change immutable evidence, or authorize a caller Agent. */
export function isSourceOwnerContinuation(current: SourceOwnerReceipt, original: SourceOwnerReceipt): boolean {
  const stable = ['authorityId', 'authorityHash', 'principalId', 'principalRecordId',
    'workspace', 'agentPreset'] as const
  for (const receipt of [current, original]) {
    if (!receipt || receipt.receiptVersion !== 2
      || stable.some(key => typeof receipt[key] !== 'string' || !receipt[key] || receipt[key].trim() !== receipt[key])
      || !/^[a-f0-9]{64}$/u.test(receipt.authorityHash)
      || ![receipt.principalVersion, receipt.bindingVersion, receipt.generation]
        .every(value => Number.isSafeInteger(value) && value > 0)) return false
  }
  return stable.every(key => current[key] === original[key])
    && current.principalVersion === original.principalVersion
    && current.generation >= original.generation
    && (current.generation !== original.generation || current.bindingVersion === original.bindingVersion)
}
