const crypto = require("node:crypto");

function secureUnitRandom() {
  return crypto.randomBytes(6).readUIntBE(0, 6) / 281474976710656;
}

function chooseFairProgram(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const avoidConsecutive = options.avoidConsecutive !== false;
  const balance = Math.max(0, Math.min(1, Number(options.balance ?? 0.7)));
  const lastProgramId = options.lastProgramId ?? null;
  const now = Number(options.now ?? Date.now());
  let pool = candidates;

  if (avoidConsecutive && lastProgramId !== null) {
    const alternatives = candidates.filter((candidate) => candidate.programId !== lastProgramId);
    if (alternatives.length) pool = alternatives;
  }

  const weighted = pool.map((candidate) => {
    const selectedAt = candidate.lastSelectedAt ? new Date(candidate.lastSelectedAt).getTime() : 0;
    const hoursSince = selectedAt ? Math.max(0, (now - selectedAt) / 3_600_000) : 24 * 30;
    const fairness = 1 + Math.min(30, hoursSince / 12) + 4 / (1 + Number(candidate.selectionCount || 0));
    return {
      candidate,
      weight: (1 - balance) + balance * fairness
    };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let cursor = (options.random ?? secureUnitRandom)() * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.candidate;
  }
  return weighted[weighted.length - 1].candidate;
}

module.exports = { chooseFairProgram };
