// Optional Langfuse tracing for every LLM call across the pipeline. Wires
// through @langfuse/tracing's OpenTelemetry instrumentation -- entirely
// opt-in, same as COPILOTKIT_TELEMETRY_DISABLED: if LANGFUSE_PUBLIC_KEY /
// LANGFUSE_SECRET_KEY aren't set, nothing here runs and startObservation()
// calls elsewhere become no-ops.
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

export const tracingEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

if (tracingEnabled) {
  const spanProcessor = new LangfuseSpanProcessor();
  const provider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
  provider.register();
  console.log(`Langfuse tracing enabled -> ${process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com'}`);
}
