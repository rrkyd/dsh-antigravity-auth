import { beforeEach, describe, expect, it } from 'vitest'
import {
  RequestShapeError,
  assertNotRateFused,
  buildGuardedRequestBody,
  inspectRequestShape,
  noteRateLimit,
  resetRateFuseForTest,
  shapeLimits,
} from '../src/request-guard.ts'

function payloadWith(toolCount: number, systemText = 'system'): Record<string, unknown> {
  return {
    requestId: 'request-1',
    request: {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: systemText }] },
      ...(toolCount === 0 ? {} : {
        tools: [{
          functionDeclarations: Array.from({ length: toolCount }, (_, index) => ({
            name: `tool_${index}`,
            description: 'd'.repeat(120),
            parameters: { type: 'object', properties: {} },
          })),
        }],
      }),
    },
  }
}

describe('request shape gate', () => {
  beforeEach(() => {
    resetRateFuseForTest()
    delete process.env['ANTIGRAVITY_MAX_TOOLS']
    delete process.env['ANTIGRAVITY_MAX_REQUEST_BYTES']
    delete process.env['ANTIGRAVITY_MAX_SYSTEM_BYTES']
  })

  it('passes a request shaped like a real CLI session', () => {
    const payload = payloadWith(10)
    const report = inspectRequestShape(payload, JSON.stringify(payload))
    expect(report.toolCount).toBe(10)
    expect(report.blocking).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('warns on an oversized tool catalog without refusing the send', () => {
    const payload = payloadWith(64)
    const report = inspectRequestShape(payload, JSON.stringify(payload))
    expect(report.toolCount).toBe(64)
    expect(report.blocking).toEqual([])
    expect(report.warnings.join('\n')).toMatch(/tool catalog offers 64 declarations/)
    expect(() => buildGuardedRequestBody(payload)).not.toThrow(RequestShapeError)
  })

  it('refuses an oversized body before send', () => {
    process.env['ANTIGRAVITY_MAX_REQUEST_BYTES'] = '2048'
    expect(shapeLimits().maxRequestBytes).toBe(2048)
    expect(() => buildGuardedRequestBody(payloadWith(10))).toThrow(/request body is/)
  })

  it('only warns on an oversized system instruction', () => {
    process.env['ANTIGRAVITY_MAX_SYSTEM_BYTES'] = '2048'
    const payload = payloadWith(0, 's'.repeat(4096))
    const report = inspectRequestShape(payload, JSON.stringify(payload))
    expect(report.blocking).toEqual([])
    expect(report.warnings).toHaveLength(1)
    expect(report.warnings[0]).toMatch(/systemInstruction is/)
  })

  it('opens the fuse after three rate-limit responses and closes after the window', () => {
    const limits = shapeLimits()
    const start = 1_000_000
    noteRateLimit(start, limits)
    noteRateLimit(start + 1_000, limits)
    expect(() => assertNotRateFused(start + 2_000, limits)).not.toThrow()
    noteRateLimit(start + 2_000, limits)
    expect(() => assertNotRateFused(start + 3_000, limits)).toThrow(/rate-limit responses within/)
    expect(() => assertNotRateFused(start + limits.rateLimitWindowMs + 5_000, limits)).not.toThrow()
  })
})
