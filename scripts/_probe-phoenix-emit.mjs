import dotenv from 'dotenv';
dotenv.config({ path: 'D:/Users/pares/Desktop/tracepilot-gemini-cli/.env', quiet: true });
const apiKey = process.env.PHOENIX_API_KEY?.replace(/^['"]|['"]$/g,'').trim();
const project = process.env.PHOENIX_PROJECT;
const rawUrl = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? process.env.PHOENIX_BASE_URL;
const url = rawUrl?.replace(/^['"]|['"]$/g,'').replace(/\/$/, '');
console.log('apiKey prefix:', apiKey?.slice(0,12), 'project:', project, 'url:', url?.slice(0,50));

const { register: registerPhoenix } = await import('@arizeai/phoenix-otel');
const { trace } = await import('@opentelemetry/api');

const provider = registerPhoenix({ projectName: project, url, apiKey, batch: false });
const tracer = trace.getTracer('tracepilot-repair-memory-demo');
const span = tracer.startSpan('gemini_cli.chain.repair_report', {
  attributes: {
    'session.id': 'probe-' + Date.now(),
    'gemini_cli.repair.signature_id': 'tracepilot-failure-43cd8d38e5516baa97a34e24',
    'gemini_cli.repair.root_cause': 'typescript_incompatibility',
    'gemini_cli.repair.verification_passed': true,
    'gemini_cli.repair.confidence_score': 0.82,
  }
});
span.end();

if (provider?.forceFlush) await provider.forceFlush();
if (provider?.shutdown) await provider.shutdown();
console.log('SUCCESS: Span emitted to Phoenix!');
