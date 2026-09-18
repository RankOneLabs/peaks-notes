/** FNV-1a mapped to [0, 1); stable across platforms and runtimes. */
export const auditSampleValue = (chunkId: string, auditSeed: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(`${chunkId}\u0000${auditSeed}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
};

export const sampleAudit = (
  chunkId: string,
  auditSeed: string,
  bypassAuditRate: number,
): boolean => bypassAuditRate >= 1 || (bypassAuditRate > 0 && auditSampleValue(chunkId, auditSeed) < bypassAuditRate);
