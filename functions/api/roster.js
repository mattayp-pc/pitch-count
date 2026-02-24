export async function onRequestGet({ env }) {
  const fileId = env.ROSTER_FILE_ID;
  if (!fileId) {
    return json({ ok:false, error:'Missing env var ROSTER_FILE_ID' }, 500);
  }

  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  const resp = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });

  if (!resp.ok) {
    return json({ ok:false, error:'Failed to fetch roster JSON', details: await resp.text() }, 500);
  }

  // Return the JSON directly
  const text = await resp.text();
  return new Response(text, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300'
    }
  });
}

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
