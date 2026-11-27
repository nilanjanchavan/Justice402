/**
 * Helpers for persisting dispute evidence payloads and building live Execution Timeline runs.
 */

export interface StoredDisputeEvidence {
  disputePda: string;
  responsePayload: any;
  receiptBase64: string;
  signatureBase64: string;
  openTxSig?: string;
  paymentTxSig?: string;
  providerWallet?: string;
}

const EVIDENCE_STORAGE_KEY = "justice402_dispute_evidence_v1";
const LIVE_RUN_STORAGE_KEY = "justice402_live_run_v1";

export function saveDisputeEvidence(entry: StoredDisputeEvidence): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(EVIDENCE_STORAGE_KEY);
    const map: Record<string, StoredDisputeEvidence> = raw ? JSON.parse(raw) : {};
    map[entry.disputePda] = entry;
    window.localStorage.setItem(EVIDENCE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

export function getDisputeEvidence(disputePda: string): StoredDisputeEvidence | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EVIDENCE_STORAGE_KEY);
    if (!raw) return null;
    const map: Record<string, StoredDisputeEvidence> = JSON.parse(raw);
    return map[disputePda] || null;
  } catch {
    return null;
  }
}

export function saveLiveRun(runData: any): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIVE_RUN_STORAGE_KEY, JSON.stringify(runData));
  } catch {
    // ignore
  }
}

export function loadLiveRun(): any | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LIVE_RUN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

