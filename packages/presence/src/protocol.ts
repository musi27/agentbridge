// Wire format of agentbridge-helper (see native/main.swift) and the LAError → PresenceResult mapping.
import type { PresenceResult } from '@agentbridge/protocol';

export type HelperSubcommand = 'presence' | 'keychain-get' | 'keychain-set' | 'keychain-delete' | 'version';

export type HelperResponse =
  | { ok: true; value?: string | null; deleted?: boolean; version?: string; protocol?: number }
  | { ok: false; error?: string; detail?: string; la_code?: number; stage?: string; os_status?: number };

/** LAError codes (LocalAuthentication/LAError.h). */
export const LA_ERROR = {
  authenticationFailed: -1,
  userCancel: -2,
  userFallback: -3,
  systemCancel: -4,
  passcodeNotSet: -5,
  biometryNotAvailable: -6,
  biometryNotEnrolled: -7,
  biometryLockout: -8,
  appCancel: -9,
  invalidContext: -10,
  watchOrCompanionNotAvailable: -11,
  biometryNotPaired: -12,
  biometryDisconnected: -13,
  notInteractive: -1004,
} as const;

export class HelperProtocolError extends Error {
  override name = 'HelperProtocolError';
}

/** Parses the helper's single-line JSON stdout. Throws HelperProtocolError on anything malformed. */
export function parseHelperResponse(stdout: string): HelperResponse {
  const text = stdout.trim();
  if (text === '') throw new HelperProtocolError('helper wrote no response');
  if (text.includes('\n')) throw new HelperProtocolError('helper wrote more than one line');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HelperProtocolError('helper response is not JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HelperProtocolError('helper response is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== 'boolean') throw new HelperProtocolError('helper response lacks boolean "ok"');
  for (const k of ['error', 'detail', 'stage', 'version'] as const) {
    if (k in o && typeof o[k] !== 'string') throw new HelperProtocolError(`helper response field "${k}" is not a string`);
  }
  for (const k of ['la_code', 'os_status', 'protocol'] as const) {
    if (k in o && !Number.isInteger(o[k])) throw new HelperProtocolError(`helper response field "${k}" is not an integer`);
  }
  if ('value' in o && o.value !== null && typeof o.value !== 'string') throw new HelperProtocolError('helper response field "value" is not a string or null');
  if ('deleted' in o && typeof o.deleted !== 'boolean') throw new HelperProtocolError('helper response field "deleted" is not a boolean');
  return o as HelperResponse;
}

/** Serialises one request. Secrets go here (stdin), never into argv/env. */
export function encodeHelperRequest(req: Record<string, string | number>): string {
  return `${JSON.stringify(req)}\n`;
}

/** Maps a helper `presence` response to the platform-neutral PresenceResult (§9.2). */
export function presenceResultFrom(res: HelperResponse): PresenceResult {
  if (res.ok) return { ok: true, method: 'biometric_or_password' };
  const detail = res.detail;
  const withDetail = <C extends Extract<PresenceResult, { ok: false }>['code']>(code: C): PresenceResult =>
    detail === undefined ? { ok: false, code } : { ok: false, code, detail };
  if (res.stage === 'timeout') return { ok: false, code: 'error', detail: `timed out${detail === undefined ? '' : `: ${detail}`}` };
  if (res.la_code === undefined) return withDetail('error');
  switch (res.la_code) {
    case LA_ERROR.userCancel:
      return withDetail('cancelled');
    case LA_ERROR.authenticationFailed:
      return withDetail('failed');
    case LA_ERROR.systemCancel:
      return withDetail('system_cancel');
    case LA_ERROR.passcodeNotSet:
    case LA_ERROR.biometryNotAvailable:
    case LA_ERROR.biometryNotEnrolled:
    case LA_ERROR.biometryLockout:
    case LA_ERROR.watchOrCompanionNotAvailable:
    case LA_ERROR.biometryNotPaired:
    case LA_ERROR.biometryDisconnected:
    case LA_ERROR.notInteractive:
      return withDetail('unavailable');
    default:
      return { ok: false, code: 'error', detail: `LAError ${res.la_code}${detail === undefined ? '' : `: ${detail}`}` };
  }
}

/** Human-readable CLI message per result code (§9.2 "map LAError codes to messages"). */
export function presenceMessage(r: PresenceResult): string {
  if (r.ok) return 'Confirmed.';
  switch (r.code) {
    case 'cancelled':
      return 'Cancelled at the Touch ID / password prompt.';
    case 'failed':
      return 'Touch ID / password was not recognised.';
    case 'system_cancel':
      return 'The system dismissed the prompt (screen locked or another app took focus). Try again.';
    case 'unavailable':
      return 'User-presence check unavailable: no Touch ID or login password usable in this session.';
    case 'error':
      return `User-presence check failed${r.detail === undefined ? '' : `: ${r.detail}`}.`;
  }
}
