const fs = require("fs");
const path = require("path");

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "Orders";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

// Parse Gemini's lyrics_json into the player's array-of-line-arrays shape,
// and pull the song title. Fails safe: bad/empty JSON -> empty lyrics, null title.
function parseSong(jsonStr) {
  if (!jsonStr) return { title: null, lines: [] };
  try {
    const obj = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
    // lyrics_json_a is stored as the per-song object (song_a). Be tolerant of either shape.
    const song = obj.song_a || obj.song_b || obj;
    const sections = Array.isArray(song.sections) ? song.sections : [];
    const lines = sections.map(s => Array.isArray(s.lines) ? s.lines : []);
    return { title: song.title || null, lines };
  } catch (e) {
    return { title: null, lines: [] };
  }
}

function firstAttachmentUrl(field) {
  if (Array.isArray(field) && field.length && field[0] && field[0].url) return field[0].url;
  return null;
}

// Pills show the bare genre — strip internal routing parentheticals
// e.g. "pop-rap (chaotic-tender, female-led)" -> "pop-rap" (D110)
function cleanGenre(s) {
  return String(s == null ? "" : s).replace(/\s*\([^)]*\)/g, "").trim();
}

function htmlEscapeAttr(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = async (req, res) => {
  const slug = (req.query && req.query.slug ? String(req.query.slug) : "").trim();

  if (!slug || !/^[a-f0-9]{8,32}$/.test(slug)) {
    res.status(404).send("Not found");
    return;
  }
  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    res.status(500).send("Server not configured");
    return;
  }

  try {
    const formula = encodeURIComponent(`{player_slug}="${slug}"`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?filterByFormula=${formula}&maxRecords=1`;
    const air = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!air.ok) { res.status(502).send("Upstream error"); return; }
    const data = await air.json();
    const rec = data.records && data.records[0];
    if (!rec) { res.status(404).send("Not found"); return; }
    const f = rec.fields || {};

    const songA = parseSong(f.lyrics_json_a);
    const songB = parseSong(f.lyrics_json_b);

    const chosen = f.customer_chosen_version || "Pending";
    const view = chosen === "Pending" ? "gifter" : "recipient";

    const order = {
      sendTo: f.recipient_name || "",
      sender: f.gifter_name || "",
      songTitleA: songA.title,
      songTitleB: songB.title,
      genreA: cleanGenre(f.genre_a),
      genreB: cleanGenre(f.genre_b),
      note: f.gifter_note || "",
      coverUrl: f.cover_art_url || "",
      lyricsA: songA.lines,
      lyricsB: songB.lines,
      mp3A: firstAttachmentUrl(f.suno_mp3_a),
      mp3B: firstAttachmentUrl(f.suno_mp3_b),
      chosenVersion: chosen
    };

    // Open Graph: per-order preview when shared via link
    const ogTitle = order.sendTo ? `A song for ${order.sendTo}` : "still trill";
    const ogDesc = "Not a love song. Proof.";
    const ogImage = order.coverUrl || "";

    let html = fs.readFileSync(path.join(process.cwd(), "player.html"), "utf8");

    const orderJson = JSON.stringify(order).replace(/</g, "\\u003c");

    html = html
      .split("%%ORDER_JSON%%").join(orderJson)
      .split("%%VIEW%%").join(view)
      .split("%%SLUG%%").join(slug)
      .split("%%OG_TITLE%%").join(htmlEscapeAttr(ogTitle))
      .split("%%OG_DESC%%").join(htmlEscapeAttr(ogDesc))
      .split("%%OG_IMAGE%%").join(htmlEscapeAttr(ogImage));

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(html);
  } catch (e) {
    res.status(500).send("Server error");
  }
};
