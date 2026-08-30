import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssistantHealthService } from './service.js'

export function registerAssistantHealthTool(ctx: Context, service: AssistantHealthService): void {
  ctx.tools.register(defineTool({
    name: 'assistant_health',
    description: 'Read a policy-gated, content-free health report. This detects issues and never repairs state.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        ready: { type: 'boolean', required: true }, generatedAt: { type: 'integer', required: true },
        severity: { type: 'string', required: true },
        warnings: { type: 'array', required: true, items: { type: 'string' } },
        assessments: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false, properties: {
            providerId: { type: 'string', required: true },
            severity: { type: 'string', required: true },
            code: { type: 'string', required: true },
          },
        } },
        providers: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, status: { type: 'string', required: true },
          metrics: { type: 'object', required: true, additionalProperties: true, properties: {} },
        } } },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const report = service.report(exec.agent)
      return {
        ready: report.ready,
        severity: report.severity,
        generatedAt: report.generatedAt,
        warnings: [...report.warnings],
        assessments: report.assessments.map(assessment => ({ ...assessment })),
        providers: report.providers.map(provider => ({
          id: provider.id,
          status: provider.status,
          metrics: { ...provider.metrics },
        })),
      }
    },
  }))
}
