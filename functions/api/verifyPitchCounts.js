export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const vid = (url.searchParams.get("vid") || "").trim();
    const coachName = url.searchParams.get("coachName") || "";
    const coachEmail = url.searchParams.get("coachEmail") || "";

    if (!vid) return json({ error: "Missing verification id (VID)." }, 400);
    if (!env.MAIN_SHEET_ID) return json({ error: "Missing MAIN_SHEET_ID." }, 500);

    const verifiedBy = buildVerifiedBy(coachName, coachEmail);
    const dateTimeStr = formatPacificDateTime(new Date()); // change TZ if you want

    const token = await getGoogleAccessToken(env);
    const sheetId = env.MAIN_SHEET_ID;

    // List all sheet titles
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`;
    const metaResp = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaResp.ok) return json({ error: "Metadata read failed", details: await metaResp.text() }, 500);
    const meta = await metaResp.json();

    const titles = (meta.sheets || []).map(s => s?.properties?.title).filter(Boolean);
    const candidateTitles = titles.filter(t =>
      t !== "Coaches_Email" &&
      t !== "Disputes" &&
      !String(t).startsWith("_")
    );

    for (const tabName of candidateTitles) {
      // Read column O from row 4 down
      const colORange = `${quoteSheetName(tabName)}!O4:O`;
      const oUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(colORange)}?majorDimension=ROWS`;
      const oResp = await fetch(oUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!oResp.ok) continue;

      const oData = await oResp.json();
      const oValues = Array.isArray(oData.values) ? oData.values : [];

      const matchingRows = [];
      for (let i = 0; i < oValues.length; i++) {
        const v = (oValues[i] && oValues[i][0] != null) ? String(oValues[i][0]).trim() : "";
        if (v === vid) matchingRows.push(4 + i); // actual sheet row number
      }
      if (!matchingRows.length) continue;

      // Read date (col I) and opponent (col J) from the first matching row
      let dateDisplay = "";
      let opponentDisplay = "";
      const firstRow = matchingRows[0];
      const ijRange = `${quoteSheetName(tabName)}!I${firstRow}:J${firstRow}`;
      const ijUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(ijRange)}?majorDimension=ROWS`;
      const ijResp = await fetch(ijUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (ijResp.ok) {
        const ijData = await ijResp.json();
        const ijRow = (ijData.values || [])[0] || [];
        dateDisplay     = String(ijRow[0] ?? "").trim();
        opponentDisplay = String(ijRow[1] ?? "").trim();
      }

      // Update M:N for each matching row using values:batchUpdate
      const data = matchingRows.map(r => ({
        range: `${quoteSheetName(tabName)}!M${r}:N${r}`,
        values: [[dateTimeStr, verifiedBy]]
      }));

      const batchUrl =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
        `/values:batchUpdate?valueInputOption=USER_ENTERED`;

      const upResp = await fetch(batchUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data })
      });

      if (!upResp.ok) return json({ error: "Write failed", details: await upResp.text() }, 500);

      return json({
        message: `Verification recorded. (${tabName})`,
        sheet: tabName,
        rows: matchingRows.length,
        dateDisplay,
        opponentDisplay
      });
    }

    return json({ error: "VID not found in any team sheet." }, 404);

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
function buildVerifiedBy(coachName, coachEmail) {
  const n = (coachName || "").trim();
  const e = (coachEmail || "").trim();
  if (n && e) return `${n} (${e})`;
  return e || n || "Verified";
}
function formatPacificDateTime(d) {
  // "M/d/yyyy h:mm a" in America/Los_Angeles
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  }).formatToParts(d).reduce((a,p)=>{a[p.type]=p.value;return a;},{});
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

/* service account token helpers (same as your other functions) */
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
