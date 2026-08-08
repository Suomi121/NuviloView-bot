import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDashboardPrintReportHtml,
  escapeReportHtml,
} from "../lib/dashboard-report-utils.mjs";

test("report HTML escapes every executable HTML delimiter", () => {
  assert.equal(
    escapeReportHtml(`<img src=x onerror="alert('x')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;",
  );
});

test("PDF report renders a malicious Discord Guild name only as text", () => {
  const maliciousGuildName =
    `</p><img src=x onerror="fetch('/api/developer/guilds')"><p>`;
  const html = buildDashboardPrintReportHtml({
    documentTitle: "report",
    guildName: maliciousGuildName,
    periodLabel: "7 days",
    memberLabel: "Members",
    messageLabel: "Messages",
    voiceLabel: "Voice",
    memberCount: 10,
    messageCount: 20,
    voiceDuration: "1 hour",
    dateLabel: "Date",
    rows: [{ date: "07/30", messages: 20, members: 10 }],
  });

  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /&lt;\/p&gt;&lt;img/);
  assert.match(html, /onerror=&quot;fetch/);
});
