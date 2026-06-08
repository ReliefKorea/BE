import loadEnv from '../../loadEnv.js';

loadEnv();

function parseArgs(argv) {
  const options = {
    eventId: '',
    limit: undefined,
    baseUrl: process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}/api`
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const [key, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.eventId) {
    throw new Error('Usage: npm run rag:orgs -- --eventId=<event_id> [--limit=3]');
  }

  const { eventId, baseUrl, ...ragOptions } = options;
  const response = await fetch(`${baseUrl}/admin/events/${encodeURIComponent(eventId)}/rag/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ragOptions)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `RAG request failed: ${response.status}`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch(error => {
  console.error(`Organization RAG failed: ${error.message}`);
  process.exitCode = 1;
});
