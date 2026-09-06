// Weight anomaly guard. A single bad check-in (someone else on the scale, a
// kg/lb glitch) otherwise flows straight into wger. This rejects a candidate
// that deviates too far from the trailing median, or is outside sane bounds.

// Percentage deviation from the trailing median that counts as anomalous.
const ANOMALY_PCT = Number(process.env.WEIGHT_ANOMALY_PCT ?? 0.12);
// Absolute sanity bounds (in the STORED unit — lb when SPARKY_WEIGHT_KG_TO_LB).
const MIN = Number(process.env.WEIGHT_MIN ?? 50);
const MAX = Number(process.env.WEIGHT_MAX ?? 500);
// Need at least this many reference points before the median check applies,
// so a fresh install doesn't reject its whole first backlog.
const MIN_REFS = Number(process.env.WEIGHT_ANOMALY_MIN_REFS ?? 3);

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface AnomalyVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Decide whether `candidate` is a plausible next weight given recent accepted
 * weights (`refs`, same unit as candidate). ok:false means quarantine it.
 */
export function checkWeight(candidate: number, refs: number[]): AnomalyVerdict {
  if (!(candidate >= MIN && candidate <= MAX)) {
    return { ok: false, reason: `outside bounds ${MIN}-${MAX} (got ${candidate})` };
  }
  if (refs.length < MIN_REFS) return { ok: true }; // not enough history to judge
  const med = median(refs);
  if (med <= 0) return { ok: true };
  const dev = Math.abs(candidate - med) / med;
  if (dev > ANOMALY_PCT) {
    return {
      ok: false,
      reason: `${(dev * 100).toFixed(0)}% off trailing median ${med.toFixed(1)} (got ${candidate})`,
    };
  }
  return { ok: true };
}
