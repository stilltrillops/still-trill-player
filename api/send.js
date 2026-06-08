const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "Orders";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) {
      if (typeof req.body === "string") { try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); } }
      return resolve(req.body);
    }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); } });
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "method_not_allowed" }); return; }
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) { res.status(500).json({ error: "not_configured" }); return; }

  const body = await readBody(req);
  const slug = (body.slug ? String(body.slug) : "").trim();
  const version = (body.version ? String(body.version) : "").toUpperCase();
  const note = body.note != null ? String(body.note).slice(0, 200) : "";

  if (!/^[a-f0-9]{8,32}$/.test(slug)) { res.status(400).json({ error: "bad_slug" }); return; }
  if (version !== "A" && version !== "B") { res.status(400).json({ error: "bad_version" }); return; }

  try {
    const formula = encodeURIComponent(`{player_slug}="${slug}"`);
    const findUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${formula}&maxRecords=1`;
    const findRes = await fetch(findUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!findRes.ok) { res.status(502).json({ error: "upstream" }); return; }
    const found = await findRes.json();
    const rec = found.records && found.records[0];
    if (!rec) { res.status(404).json({ error: "not_found" }); return; }

    // The choice is final — do not let a second tap overwrite a sent gift.
    if (rec.fields && rec.fields.customer_chosen_version && rec.fields.customer_chosen_version !== "Pending") {
      res.status(409).json({ error: "already_sent", chosenVersion: rec.fields.customer_chosen_version });
      return;
    }

    const patchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${rec.id}`;
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { customer_chosen_version: version, gifter_note: note } })
    });
    if (!patchRes.ok) { res.status(502).json({ error: "write_failed" }); return; }

    res.status(200).json({ ok: true, chosenVersion: version });
  } catch (e) {
    res.status(500).json({ error: "server_error" });
  }
};
