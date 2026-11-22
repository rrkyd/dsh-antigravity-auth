import { Buffer } from 'node:buffer'

/**
 * Pre-send request-shape gate.
 *
 * The private backend sees this plugin as an `agy` CLI client. What makes a
 * request look unlike that client is its shape, not its content: an outsized
 * tool catalog, a body several times larger than a real CLI session, or a burst
 * of 429s from one account. A violation is a configuration bug (too many MCP
 * servers mounted in the agent preset), so this gate refuses to send and names
 * the fix instead of trimming the request into something the model cannot use.
 *
 * Nothing here touches the wire identity: the `agy` User-Agent, the agent
 * request type and the truthful DSH attribution header stay exactly as
 * audited. Only the size and repetition of what we ask for is bounded.
 */

export interface RequestShapeLimits {
  maxTools: number
  maxRequestBytes: number
  maxSystemBytes: number
  rateLimitFuse: number
  rateLimitWindowMs: number
}

const DEFAULTS: RequestShapeLimits = {
  maxTools: 48,
  maxRequestBytes: 262_144,
  maxSystemBytes: 65_536,
  rateLimitFuse: 3,
  rateLimitWindowMs: 10 * 60_000,
}

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

export function shapeLimits(): RequestShapeLimits {
  return {
    maxTools: envLimit('ANTIGRAVITY_MAX_TOOLS', DEFAULTS.maxTools),
    maxRequestBytes: envLimit('ANTIGRAVITY_MAX_REQUEST_BYTES', DEFAULTS.maxRequestBytes),
    maxSystemBytes: envLimit('ANTIGRAVITY_MAX_SYSTEM_BYTES', DEFAULTS.maxSystemBytes),
    rateLimitFuse: envLimit('ANTIGRAVITY_RATE_FUSE', DEFAULTS.rateLimitFuse),
    rateLimitWindowMs: envLimit('ANTIGRAVITY_RATE_FUSE_WINDOW_MS', DEFAULTS.rateLimitWindowMs),
  }
}

export class RequestShapeError extends Error {
  readonly violations: readonly string[]

  constructor(violations: readonly string[]) {
    super([
      'Antigravity request refused:',
      ...violations.map(violation => `  - ${violation}`),
      'Nothing was sent, so this costs the account nothing.',
      'Fix the shape (unmount MCP servers in the agent preset) before raising a limit.',
    ].join('\n'))
    this.name = 'AntigravityRequestShapeError'
    this.violations = violations
  }
}

function toolDeclarationCount(request: Record<string, unknown> | undefined): number {
  const tools = request?.['tools']
  if (!Array.isArray(tools)) return 0
  let count = 0
  for (const toolset of tools) {
    const declarations = (toolset as { functionDeclarations?: unknown } | null)?.['functionDeclarations']
    if (Array.isArray(declarations)) count += declarations.length
  }
  return count
}

function systemInstructionBytes(request: Record<string, unknown> | undefined): number {
  const instruction = request?.['systemInstruction'] as { parts?: unknown } | undefined
  const parts = instruction?.parts
  if (!Array.isArray(parts)) return 0
  let bytes = 0
  for (const part of parts) {
    const text = (part as { text?: unknown } | null)?.['text']
    if (typeof text === 'string') bytes += Buffer.byteLength(text, 'utf8')
  }
  return bytes
}

export interface RequestShapeReport {
  readonly toolCount: number
  readonly requestBytes: number
  readonly systemBytes: number
  readonly blocking: readonly string[]
  readonly warnings: readonly string[]
}

export function inspectRequestShape(
  payload: Record<string, unknown>,
  body: string,
  limits: RequestShapeLimits = shapeLimits(),
): RequestShapeReport {
  const request = payload['request'] as Record<string, unknown> | undefined
  const toolCount = toolDeclarationCount(request)
  const requestBytes = Buffer.byteLength(body, 'utf8')
  const systemBytes = systemInstructionBytes(request)
  const blocking: string[] = []
  const warnings: string[] = []
  if (toolCount > limits.maxTools) {
    warnings.push(`tool catalog offers ${toolCount} declarations > ANTIGRAVITY_MAX_TOOLS ${limits.maxTools}`)
  }
  if (requestBytes > limits.maxRequestBytes) {
    blocking.push(`request body is ${Math.round(requestBytes / 1024)} KB > ANTIGRAVITY_MAX_REQUEST_BYTES ${Math.round(limits.maxRequestBytes / 1024)} KB`)
  }
  if (systemBytes > limits.maxSystemBytes) {
    warnings.push(`systemInstruction is ${Math.round(systemBytes / 1024)} KB > ANTIGRAVITY_MAX_SYSTEM_BYTES ${Math.round(limits.maxSystemBytes / 1024)} KB`)
  }
  return { toolCount, requestBytes, systemBytes, blocking, warnings }
}

const emittedWarnings = new Set<string>()

function emitWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (emittedWarnings.has(warning)) continue
    emittedWarnings.add(warning)
    process.emitWarning(`antigravity-auth: ${warning}`, { code: 'ANTIGRAVITY_REQUEST_SHAPE' })
  }
}

/** Serialise once, refuse the body if it would look alien on the wire. */
export function buildGuardedRequestBody(
  payload: Record<string, unknown>,
  limits: RequestShapeLimits = shapeLimits(),
): string {
  const body = JSON.stringify(payload)
  const report = inspectRequestShape(payload, body, limits)
  if (report.blocking.length > 0) throw new RequestShapeError(report.blocking)
  emitWarnings(report.warnings)
  return body
}

export interface RateFuse {
  note(now?: number, limits?: RequestShapeLimits): number
  assertClosed(now?: number, limits?: RequestShapeLimits): void
  reset(): void
}

/**
 * An open fuse turns repeating rate-limit verdicts into a hard stop: the
 * pre-existing contract is that a 429 is reported without a resend, so the only
 * thing left to protect is the next turn, which would otherwise ask for the same
 * refused shape again.
 *
 * ponytail: one fuse per adapter instance — that is one per plugin process in
 * production, and one per test cassette in tests. Key it by credential if a
 * multi-account rotation ever lands in this plugin.
 */
export function createRateFuse(): RateFuse {
  const hits: number[] = []
  const prune = (now: number, limits: RequestShapeLimits): void => {
    const cutoff = now - limits.rateLimitWindowMs
    while (hits.length > 0 && (hits[0] ?? 0) < cutoff) hits.shift()
  }
  return {
    note(now: number = Date.now(), limits: RequestShapeLimits = shapeLimits()): number {
      hits.push(now)
      prune(now, limits)
      return hits.length
    },
    assertClosed(now: number = Date.now(), limits: RequestShapeLimits = shapeLimits()): void {
      prune(now, limits)
      if (hits.length < limits.rateLimitFuse) return
      throw new RequestShapeError([
        `${hits.length} rate-limit responses within ${Math.max(1, Math.round(limits.rateLimitWindowMs / 60_000))} min`,
        'The fuse is open: this account keeps asking for the same refused request shape.',
        'Stop issuing agent turns here until the window passes.',
      ])
    },
    reset(): void {
      hits.length = 0
    },
  }
}
