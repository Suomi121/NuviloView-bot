export function escapeReportHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

export function buildDashboardPrintReportHtml({
  documentTitle,
  guildName,
  periodLabel,
  memberLabel,
  messageLabel,
  voiceLabel,
  memberCount,
  messageCount,
  voiceDuration,
  dateLabel,
  rows,
}) {
  const safe = escapeReportHtml;
  const tableRows = (Array.isArray(rows) ? rows : [])
    .map(
      (row) =>
        `<tr><td>${safe(row?.date)}</td><td>${safe(row?.messages)}</td><td>${safe(row?.members)}</td></tr>`,
    )
    .join("");

  return (
    "<!doctype html><html><head>" +
    `<title>${safe(documentTitle)}</title>` +
    "<style>body{font-family:Arial,sans-serif;padding:32px;color:#171717}h1{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f4f4f5}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:20px}.card{border:1px solid #ddd;border-radius:10px;padding:12px}.label{font-size:12px;color:#666}.value{font-size:22px;font-weight:700;margin-top:4px}</style>" +
    "</head><body><h1>NuviloView:OEM Report</h1>" +
    `<p>${safe(guildName)} · ${safe(periodLabel)}</p>` +
    '<div class="grid">' +
    `<div class="card"><div class="label">${safe(memberLabel)}</div><div class="value">${safe(memberCount)}</div></div>` +
    `<div class="card"><div class="label">${safe(messageLabel)}</div><div class="value">${safe(messageCount)}</div></div>` +
    `<div class="card"><div class="label">${safe(voiceLabel)}</div><div class="value">${safe(voiceDuration)}</div></div>` +
    "</div><table><thead><tr>" +
    `<th>${safe(dateLabel)}</th><th>${safe(messageLabel)}</th><th>${safe(memberLabel)}</th>` +
    `</tr></thead><tbody>${tableRows}</tbody></table></body></html>`
  );
}
