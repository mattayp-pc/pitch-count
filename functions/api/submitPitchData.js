export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const submission = body?.payload ?? body;

    if (!submission?.gameDate) return json({ success:false, error:'Missing gameDate' }, 400);
    const games = Array.isArray(submission.games) ? submission.games : [];
    if (!games.length) return json({ success:false, error:'No games found in submission' }, 400);

    const sheetId = env.MAIN_SHEET_ID;
    if (!sheetId) return json({ success:false, error:'Missing env var MAIN_SHEET_ID' }, 500);

    // Team tab name from Game 1 submitting.team (e.g., "Bishop_Gorman")
    const tabName = String(games?.[0]?.submitting?.team || '').trim();
    if (!tabName) return json({ success:false, error:'Submitting team missing (game 1)' }, 400);

    const coachRole = String(submission.coachRole || 'VARSITY').trim().toUpperCase(); // "VARSITY" or "JV"
    const formattedDate = formatMDY(submission.gameDate); // M/d/yyyy string

    const allRows = [];
    const emailJobs = []; // collect per in-state game

    for (const game of games) {
      const opp = game?.opponent || {};
      const isOutOfState = opp.type === 'out-of-state';

      const opponentSchool = isOutOfState
        ? String(opp.school || '').trim()
        : String(opp.team || '').trim();   // underscored value (e.g. "Del_Sol")

      const pitchers = Array.isArray(game.pitchers) ? game.pitchers : [];
      const perGamePitchers = pitchers
        .map(p => ({
          name: String(p?.player || p?.playerId || '').trim().replace(/\s+/g, ' '),
          count: (p?.pitch_count ?? p?.pitches),
          jerseyNumber: (p?.jerseyNumber !== null && p?.jerseyNumber !== undefined) ? p.jerseyNumber : null
        }))
        .filter(p => p.name && p.count !== '' && p.count !== null && !Number.isNaN(Number(p.count)));

      if (!perGamePitchers.length) continue;

      // One VID per in-state game
      const vid = (!isOutOfState && opponentSchool) ? crypto.randomUUID() : '';

      // Build sheet rows (I:O)
      for (const p of perGamePitchers) {
        allRows.push([
          formattedDate,               // I Date
          opponentSchool,              // J Opponent
          p.name,                      // K Player
          Number(p.count),             // L Pitch Count
          '',                          // M Verification Date/Time
          '',                          // N Verified By
          vid                          // O VID (blank for out-of-state)
        ]);
      }

      // Email job for in-state only
      if (vid) {
        emailJobs.push({
          opponentSchool,                 // ex: "Del_Sol"
          submittingSchool: tabName,      // ex: "SECTA"
          formattedDate,
          verificationId: vid,
          coachRole,
          opponentPitchers: perGamePitchers.map(x => ({
            name: x.name,
            pitchCount: Number(x.count),
            jerseyNumber: x.jerseyNumber
          }))
        });
      }
    }

    if (!allRows.length) return json({ success:false, error:'No valid pitchers provided.' }, 400);

    const token = await getGoogleAccessToken(env);

    // Ensure the tab exists (create if missing)
    await ensureSheetTabExists({ token, sheetId, tabName });

    // Find first blank in column I starting at row 4
    const startRow = await findFirstBlankRowInColI({ token, sheetId, tabName, fromRow: 4, maxRows: 5000 });

    // Write I:O starting at startRow
    const a1 = `${quoteSheetName(tabName)}!I${startRow}:O${startRow + allRows.length - 1}`;

    const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`;

    const putResp = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: allRows })
    });

    if (!putResp.ok) {
      const t = await putResp.text();
      return json(
        { success:false, error:`Sheets API write error (${putResp.status})`, details: t },
        500
      );
    }

    // -------- EMAIL RELAY (after successful write) --------
    // Optional: only run if env vars present
    const relayUrl = env.EMAIL_RELAY_URL;
    const relayKey = env.EMAIL_RELAY_KEY;
    const siteBaseUrl = env.SITE_BASE_URL; // e.g. https://pitch-count.pages.dev or custom domain
    const coachSheetId = env.COACH_EMAIL_SHEET_ID;
    const coachSheetName = env.COACH_EMAIL_SHEET_NAME || 'Home';

    let emailsAttempted = 0;
    let emailsSent = 0;

    if (relayUrl && relayKey && siteBaseUrl && coachSheetId) {
      // Read coach directory once
      const coachDirectory = await fetchCoachDirectory_({
        token,
        spreadsheetId: coachSheetId,
        tabName: coachSheetName
      });

      // Send each email job (sequential is simplest; you can Promise.all if you prefer)
      for (const job of emailJobs) {
        const coach = pickOpponentCoach_(coachDirectory, job.opponentSchool, job.coachRole);
        if (!coach?.email) continue;
      
        emailsAttempted++;
      
        const relayResp = await fetch(relayUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            relayKey: relayKey,
            opponentSchool: job.opponentSchool,
            submittingSchool: job.submittingSchool,
            formattedDate: job.formattedDate,
            opponentPitchers: job.opponentPitchers,
            verificationId: job.verificationId,
            coachRole: job.coachRole,
            coachName: coach.name || "",
            coachEmail: coach.email || "",
            siteBaseUrl: siteBaseUrl
          })
        });
      
        if (relayResp.ok) {
          emailsSent++;
        } else {
          console.log("Email relay failed", relayResp.status, await relayResp.text());
        }
      }
    }

    return json({
      success: true,
      message: `Submitted ${allRows.length} pitcher(s) for ${tabName} on ${formattedDate}.`,
      team: tabName,
      date: formattedDate,
      count: allRows.length,
      emailsAttempted,
      emailsSent
    });

  } catch (err) {
    return json({ success:false, error: String(err?.message || err) }, 500);
  }
}

/* ================= helpers ================= */

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type':'application/json' } });
}

function quoteSheetName(name) {
  const safe = String(name).replace(/'/g, "''");
  return `'${safe}'`;
}

function formatMDY(yyyy_mm_dd) {
  // input: "YYYY-MM-DD" -> "M/d/yyyy"
  const [y, m, d] = String(yyyy_mm_dd).split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return '';
  return `${m}/${d}/${y}`;
}

async function findFirstBlankRowInColI({ token, sheetId, tabName, fromRow, maxRows }) {
  const range = `${quoteSheetName(tabName)}!I${fromRow}:I${fromRow + maxRows - 1}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Read column I failed: ${await resp.text()}`);
  const data = await resp.json();

  const values = Array.isArray(data.values) ? data.values : [];
  for (let i = 0; i < maxRows; i++) {
    const row = values[i];
    const v = (row && row[0] != null) ? String(row[0]).trim() : '';
    if (!v) return fromRow + i;
  }
  return fromRow + maxRows;
}

async function ensureSheetTabExists({ token, sheetId, tabName }) {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`;
  const metaResp = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaResp.ok) throw new Error(`Metadata read failed: ${await metaResp.text()}`);
  const meta = await metaResp.json();

  const titles = (meta.sheets || []).map(s => s?.properties?.title).filter(Boolean);
  if (titles.includes(tabName)) return;

  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`;
  const batchResp = await fetch(batchUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: tabName } } }]
    })
  });

  if (!batchResp.ok) throw new Error(`addSheet failed: ${await batchResp.text()}`);
}

/**
 * Reads coach info once from Home sheet.
 * Expected columns E..J:
 *   E teamValue, F varsityName, G varsityEmail, H (unused), I jvName, J jvEmail
 */
async function fetchCoachDirectory_({ token, spreadsheetId, tabName }) {
  const range = `${quoteSheetName(tabName)}!E2:J`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Coach sheet read failed: ${await resp.text()}`);

  const data = await resp.json();
  const rows = Array.isArray(data.values) ? data.values : [];

  const map = new Map(); // teamValueLower -> { varsity:{name,email}, jv:{name,email} }

  for (const r of rows) {
    const team = String(r?.[0] || '').trim();
    if (!team) continue;

    map.set(team.toLowerCase(), {
      varsity: { name: String(r?.[1] || '').trim(), email: String(r?.[2] || '').trim() },
      jv:      { name: String(r?.[4] || '').trim(), email: String(r?.[5] || '').trim() }
    });
  }

  return map;
}

function pickOpponentCoach_(directoryMap, opponentTeamValue, coachRole) {
  const key = String(opponentTeamValue || '').trim().toLowerCase();
  const rec = directoryMap?.get(key);
  if (!rec) return null;

  const role = String(coachRole || 'VARSITY').toUpperCase();
  const varsity = rec.varsity;
  const jv = rec.jv;

  // Match your old fallback logic
  if (role === 'JV') {
    if (jv?.email) return jv;
    if (varsity?.email) return varsity;
    return null;
  } else {
    if (varsity?.email) return varsity;
    if (jv?.email) return jv;
    return null;
  }
}

/* ===== Google service account token helpers (unchanged) ===== */

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

  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY env vars');
  }

  const jwt = await signJwt(header, payload, env.GOOGLE_PRIVATE_KEY);

  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', jwt);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function signJwt(header, payload, privateKeyPemRaw) {
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const unsigned = `${h}.${p}`;

  const key = await importPkcs8(privateKeyPemRaw);
  const sig = await crypto.subtle.sign({ name:'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(unsigned));

  return `${unsigned}.${base64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8(pemRaw) {
  const pem = pemRaw.replace(/\\n/g, '\n');
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' },
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
