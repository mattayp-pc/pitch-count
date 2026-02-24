export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const vid = (url.searchParams.get("vid") || "").trim();
    const disputingSchool = (url.searchParams.get("school") || "").trim();

    if (!vid) return json({ error: "Missing VID." }, 400);
    if (!env.MAIN_SHEET_ID) return json({ error: "Missing MAIN_SHEET_ID." }, 500);

    const token = await getGoogleAccessToken(env);
    const sheetId = env.MAIN_SHEET_ID;

    // List sheet titles
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=sheets.properties.title`;
    const metaResp = await fetch(metaUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!metaResp.ok) return json({ error: "Metadata read failed", details: await metaResp.text() }, 500);
    const meta = await metaResp.json();

    const titles = (meta.sheets || []).map(s => s?.properties?.title).filter(Boolean);

    // Skip admin/hidden sheets
    const candidateTitles = titles.filter(t =>
      t !== "Coaches_Email" &&
      t !== "Disputes" &&
      !String(t).startsWith("_")
    );

    // Scan sheets for VID in column O (15), starting row 4
    for (const tabName of candidateTitles) {
      const colORange = `${quoteSheetName(tabName)}!O4:O`;
      const oUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(colORange)}?majorDimension=ROWS`;
      const oResp = await fetch(oUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!oResp.ok) continue;

      const oData = await oResp.json();
      const oValues = Array.isArray(oData.values) ? oData.values : [];

      // Find all row indexes where VID matches
      const hitIdx = [];
      for (let i = 0; i < oValues.length; i++) {
        const v = (oValues[i] && oValues[i][0] != null) ? String(oValues[i][0]).trim() : "";
        if (v === vid) hitIdx.push(i);
      }
      if (!hitIdx.length) continue;

      // Convert index (0-based within O4:O) to sheet row numbers
      const startRow = 4 + hitIdx[0];
      const endRow = 4 + hitIdx[hitIdx.length - 1];

      // Read I:O for just those rows (I=Date, J=Opponent, K=Player, L=Count, ... O=VID)
      const ioRange = `${quoteSheetName(tabName)}!I${startRow}:O${endRow}`;
      const ioUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(ioRange)}?majorDimension=ROWS`;
      const ioResp = await fetch(ioUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!ioResp.ok) return json({ error: "Failed to read I:O", details: await ioResp.text() }, 500);

      const ioData = await ioResp.json();
      const rows = Array.isArray(ioData.values) ? ioData.values : [];

      let gameDate = "";
      let opponentName = "";
      const pitchers = [];

      for (const r of rows) {
        const dateVal = r?.[0] ?? "";
        const oppVal  = r?.[1] ?? "";
        const player  = r?.[2] ?? "";
        const count   = r?.[3] ?? "";
        const rowVid  = r?.[6] ?? "";

        if (String(rowVid).trim() !== vid) continue;

        if (!gameDate) gameDate = String(dateVal);
        if (!opponentName) opponentName = String(oppVal);

        pitchers.push({
          id: `${vid}-${player}`,
          name: String(player),
          teamDisplay: tabName.replace(/_/g, " "),
          schoolValue: tabName,
          recordedPitchCount: (count === "" ? "" : Number(count))
        });
      }

      const submittingTeamDisplay = tabName.replace(/_/g, " ");
      const disputingDisplay = disputingSchool.replace(/_/g, " ");
      const matchup = `${disputingDisplay} vs ${submittingTeamDisplay}`;

      return json({
        vid,
        school: disputingSchool,
        dateDisplay: gameDate || "",
        homeTeamDisplay: disputingDisplay,
        awayTeamDisplay: submittingTeamDisplay,
        matchup,
        pitchers
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

/* ===== service account token helpers ===== */
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
