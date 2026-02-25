export async function onRequestPost({ request, env }) {
  try {
    const payload = await request.json();
    if (!payload) return json({ error: "No dispute payload received." }, 400);

    if (!env.DISPUTES_SHEET_ID) return json({ error: "Missing DISPUTES_SHEET_ID." }, 500);
    if (!env.COACH_EMAIL_SHEET_ID) return json({ error: "Missing COACH_EMAIL_SHEET_ID." }, 500);

    const token = await getGoogleAccessToken(env);

    const disputesSheetId = env.DISPUTES_SHEET_ID;
    const disputesTab = "Disputes";

    // Ensure disputes tab + header exists
    async function ensureDisputesTab({ token, spreadsheetId, tabName }) {
      // 1) ensure tab exists
      const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
      const metaResp = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!metaResp.ok) throw new Error(await metaResp.text());
      const meta = await metaResp.json();
    
      const titles = (meta.sheets || []).map(s => s?.properties?.title).filter(Boolean);
      if (!titles.includes(tabName)) {
        const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
        const addResp = await fetch(batchUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
        });
        if (!addResp.ok) throw new Error(await addResp.text());
      }
    
      // 2) if A1 already has something, don’t overwrite headers
      const a1Range = `${quoteSheetName(tabName)}!A1:A1`;
      const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1Range)}`;
      const getResp = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
      const getData = await getResp.json().catch(() => ({}));
      const a1 = (getData?.values?.[0]?.[0] || "").toString().trim();
      if (a1) return; // headers exist
    
      // 3) write headers once
      const headers = [[
        "Timestamp","VID","Disputing School","Disputing Coach Name","Disputing Coach Email","Disputing Coach Phone",
        "Recorded School Name","Recorded Coach Name","Recorded Coach Email","Recorded Coach Phone",
        "Recorded Pitcher","Recorded Count","Dispute Type","Proposed Pitcher","Proposed Count",
        "Missing Pitcher?","Disputing Coach Notes","Admin Notes"
      ]];
    
      const range = `${quoteSheetName(tabName)}!A1:R1`;
      const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
      const putResp = await fetch(putUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: headers })
      });
      if (!putResp.ok) throw new Error(await putResp.text());
    }

    const vid        = payload.vid || "";
    const school     = payload.school || "";
    const coachName  = payload.coachName || "";
    const coachEmail = payload.coachEmail || "";
    const disputes   = Array.isArray(payload.disputes) ? payload.disputes : [];
    const missing    = Array.isArray(payload.missingPitchers) ? payload.missingPitchers : [];

    const nowIso = new Date().toISOString();

    // Determine recordedSchoolValue
    let recordedSchoolValue = "";
    for (const d of disputes) { if (d?.teamSchoolValue) { recordedSchoolValue = d.teamSchoolValue; break; } }
    if (!recordedSchoolValue) {
      for (const m of missing) { if (m?.teamSchoolValue) { recordedSchoolValue = m.teamSchoolValue; break; } }
    }

    // Lookup coach contacts
    const disputingCoachInfo = await getCoachContactForSchool_({
      token, spreadsheetId: env.COACH_EMAIL_SHEET_ID, tabName: env.COACH_EMAIL_SHEET_NAME || "Home", schoolValue: school
    });
    const recordedCoachInfo = await getCoachContactForSchool_({
      token, spreadsheetId: env.COACH_EMAIL_SHEET_ID, tabName: env.COACH_EMAIL_SHEET_NAME || "Home", schoolValue: recordedSchoolValue
    });

    const disputingCoachName  = coachName  || disputingCoachInfo.name;
    const disputingCoachEmail = coachEmail || disputingCoachInfo.email;
    const disputingCoachPhone = disputingCoachInfo.phone || "";

    const recordedCoachName   = recordedCoachInfo.name  || "";
    const recordedCoachEmail  = recordedCoachInfo.email || "";
    const recordedCoachPhone  = recordedCoachInfo.phone || "";

    const rows = [];

    // Recorded disputes rows
    for (const d of disputes) {
      if (!d || d.disputeType === "none") continue;

      rows.push([
        nowIso,                    // A Timestamp
        vid,                       // B VID
        school,                    // C Disputing School
        disputingCoachName,        // D
        disputingCoachEmail,       // E
        disputingCoachPhone,       // F
        recordedSchoolValue,       // G Recorded School
        recordedCoachName,         // H
        recordedCoachEmail,        // I
        recordedCoachPhone,        // J
        d.name || "",              // K Recorded Pitcher
        d.recordedPitchCount ?? "",// L Recorded Count
        d.disputeType || "",       // M
        d.proposedPitcher || "",   // N
        d.proposedPitchCount ?? "",// O
        "",                        // P Missing Pitcher?
        d.note || "",              // Q Notes
        ""                         // R Admin Notes
      ]);
    }

    // Missing entries rows
    for (const m of missing) {
      if (!m?.name) continue;
      rows.push([
        nowIso,
        vid,
        school,
        disputingCoachName,
        disputingCoachEmail,
        disputingCoachPhone,
        recordedSchoolValue,
        recordedCoachName,
        recordedCoachEmail,
        recordedCoachPhone,
        "",                         // K
        "",                         // L
        "missing",                  // M
        m.name || "",               // N
        m.pitchCount ?? "",         // O
        "Y",                        // P
        m.note || "",               // Q
        ""                          // R
      ]);
    }

    if (!rows.length) {
      return json({ message: "No actual disputes were selected. Nothing recorded." });
    }

    const range = `${quoteSheetName(disputesTab)}!A1`; // e.g. 'Disputes'!A1

    const appendUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(disputesSheetId)}` +
      `/values/${encodeURIComponent(range)}:append` +
      `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    
    const resp = await fetch(appendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: rows })
    });
    
    if (!resp.ok) {
      const t = await resp.text();
      return json({ ok:false, error:`Sheets API append error (${resp.status})`, details: t }, 500);
    }

    return json({ message: `Dispute recorded for ${school || "(unknown school)"} (VID ${vid}).` });

  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

async function ensureDisputesTab({ token, spreadsheetId, tabName }) {
  // Check if tab exists
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`;
  const metaResp = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!metaResp.ok) throw new Error(await metaResp.text());
  const meta = await metaResp.json();

  const titles = (meta.sheets || []).map(s => s?.properties?.title).filter(Boolean);
  if (!titles.includes(tabName)) {
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`;
    const addResp = await fetch(batchUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
    });
    if (!addResp.ok) throw new Error(await addResp.text());
  }

  // Ensure header row exists (write headers to row 1)
  const headers = [[
    "Timestamp","VID","Disputing School","Disputing Coach Name","Disputing Coach Email","Disputing Coach Phone",
    "Recorded School Name","Recorded Coach Name","Recorded Coach Email","Recorded Coach Phone",
    "Recorded Pitcher","Recorded Count","Dispute Type","Proposed Pitcher","Proposed Count",
    "Missing Pitcher?","Disputing Coach Notes","Admin Notes"
  ]];

  const range = `${quoteSheetName(tabName)}!A1:R1`;
  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  await fetch(putUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: headers })
  });
}

async function getCoachContactForSchool_({ token, spreadsheetId, tabName, schoolValue }) {
  const result = { name: "", email: "", phone: "" };
  if (!schoolValue) return result;

  // E2:H => [schoolValue, coachName, coachEmail, coachPhone]
  const range = `${quoteSheetName(tabName)}!E2:H`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return result;

  const data = await resp.json();
  const rows = Array.isArray(data.values) ? data.values : [];

  const target = String(schoolValue).trim();
  for (const r of rows) {
    const sch = (r?.[0] || "").trim();
    if (sch === target) {
      result.name  = r?.[1] || "";
      result.email = r?.[2] || "";
      result.phone = r?.[3] || "";
      break;
    }
  }
  return result;
}

/* ===== service account token helpers (same as other file) ===== */
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const jwt = await signJwt(header, payload, env.GOOGLE_PRIVATE_KEY);

  const form = new URLSearchParams();
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  form.set("assertion", jwt);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64urlBytes(new Uint8Array(sig))}`;
}

async function importPkcs8(pemRaw) {
  const pem = pemRaw.replace(/\\n/g, "\n");
  const b64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64url(str) { return base64urlBytes(new TextEncoder().encode(str)); }
function base64urlBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
