export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();

    // Basic validation (customize to your schema)
    if (!body || !body.team || !body.date) {
      return json({ ok: false, error: 'Missing required fields: team, date' }, 400);
    }

    const token = await getGoogleAccessToken(env);

    // Choose which spreadsheet to write to (example)
    const sheetId = body.type === 'dispute' ? env.DISPUTES_SHEET_ID : env.MAIN_SHEET_ID;
    const tabName = body.type === 'dispute' ? (env.DISPUTES_TAB || 'Disputes') : (env.MAIN_TAB || 'Submissions');

    // Build a row (customize columns as you like)
    const row = [
      new Date().toISOString(),
      body.team,
      body.date,
      body.opponent || '',
      body.level || '',        // Varsity/JV
      body.payload ? JSON.stringify(body.payload) : '' // optional bulk payload
    ];

    // Append row to sheet
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
      `/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: [row] })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ ok: false, error: 'Sheets API error', details: errText }, 500);
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Service-account JWT → OAuth access token
 * Env needed:
 *  - GOOGLE_CLIENT_EMAIL
 *  - GOOGLE_PRIVATE_KEY
 */
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const jwt = await signJwt(header, payload, env.GOOGLE_PRIVATE_KEY);
  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', jwt);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function signJwt(header, payload, privateKeyPemRaw) {
  const enc = new TextEncoder();

  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const unsigned = `${h}.${p}`;

  const key = await importPkcs8(privateKeyPemRaw);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    enc.encode(unsigned)
  );

  return `${unsigned}.${base64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8(pemRaw) {
  // Cloudflare env vars often store "\n" literally; normalize.
  const pem = pemRaw.replace(/\\n/g, '\n');
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

function base64url(str) {
  return base64urlBytes(new TextEncoder().encode(str));
}

function base64urlBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
