// Hockey Pick Helper — one page, fully automatic.
// Runs on Cloudflare Pages Functions. On each visit it builds the page from
// NHL.com's public stats feeds and caches the result for 30 minutes.

const API = "https://api-web.nhle.com/v1";
const CACHE_SECONDS = 1800;
const SITE_NAME = "Hockey Pick Helper";

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const cache = caches.default;
  const cacheKey = new Request(url.origin + "/", { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let html;
  try {
    const data = await buildData();
    html = renderPage(data, url.origin);
  } catch (err) {
    html = renderError(url.origin);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const response = new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ---------- data ----------

async function getJSON(path) {
  const res = await fetch(`${API}/${path}`, {
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    headers: { "user-agent": "Mozilla/5.0 (compatible; HockeyPickHelper/1.0)" },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

function todayInToronto() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function buildData() {
  const today = todayInToronto();
  const [schedule, standings] = await Promise.all([
    getJSON(`schedule/${today}`),
    getJSON("standings/now"),
  ]);

  // First day (today or later) that has games.
  const day = (schedule.gameWeek || []).find((d) => d.date >= today && (d.games || []).length > 0);
  if (!day) return { date: today, games: [], players: [] };

  // Team goals-against, blending season and last 10 games.
  const teamGA = {};
  let totalGA = 0;
  let totalGP = 0;
  for (const t of standings.standings || []) {
    const abbr = t.teamAbbrev?.default;
    if (!abbr || !t.gamesPlayed) continue;
    const season = t.goalAgainst / t.gamesPlayed;
    const last10 = t.l10GamesPlayed ? t.l10GoalsAgainst / t.l10GamesPlayed : season;
    teamGA[abbr] = 0.6 * season + 0.4 * last10;
    totalGA += t.goalAgainst;
    totalGP += t.gamesPlayed;
  }
  const leagueGA = totalGP ? totalGA / totalGP : 3.0;

  const games = day.games.map((g) => ({
    id: g.id,
    start: g.startTimeUTC,
    state: g.gameState,
    away: g.awayTeam.abbrev,
    home: g.homeTeam.abbrev,
    awayName: `${g.awayTeam.placeName?.default || ""} ${g.awayTeam.commonName?.default || ""}`.trim(),
    homeName: `${g.homeTeam.placeName?.default || ""} ${g.homeTeam.commonName?.default || ""}`.trim(),
  }));

  const teams = [...new Set(games.flatMap((g) => [g.away, g.home]))];
  const teamStats = await Promise.all(
    teams.map((t) => getJSON(`club-stats/${t}/now`).catch(() => ({ skaters: [] })))
  );

  const players = [];
  teams.forEach((team, i) => {
    const game = games.find((g) => g.away === team || g.home === team);
    const isHome = game.home === team;
    const opp = isHome ? game.away : game.home;
    const oppFactor = clamp((teamGA[opp] || leagueGA) / leagueGA, 0.7, 1.4);
    const homeFactor = isHome ? 1.03 : 0.97;

    for (const s of teamStats[i].skaters || []) {
      if (!s.gamesPlayed || s.gamesPlayed < 3) continue;
      const isD = s.positionCode === "D";
      const prior = isD ? 0.07 : 0.25; // typical goals per game
      const shootPct = isD ? 0.05 : 0.11; // typical shooting %
      const goalRate = (s.goals + prior * 5) / (s.gamesPlayed + 5);
      const shotRate = (s.shots / s.gamesPlayed) * shootPct;
      const lambda = (0.5 * goalRate + 0.5 * shotRate) * oppFactor * homeFactor;
      const prob = 1 - Math.exp(-lambda);
      players.push({
        id: s.playerId,
        name: `${s.firstName?.default || ""} ${s.lastName?.default || ""}`.trim(),
        team,
        opp,
        isHome,
        pos: s.positionCode,
        gp: s.gamesPlayed,
        goals: s.goals,
        shotsPG: s.shots / s.gamesPlayed,
        ppg: s.powerPlayGoals || 0,
        toi: s.avgTimeOnIcePerGame || 0,
        prob,
        gameId: game.id,
      });
    }
  });

  players.sort((a, b) => b.prob - a.prob);
  return { date: day.date, games, players };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------- rendering ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtShortDate(iso) {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtTime(utc) {
  return new Date(utc).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) + " ET";
}

function fmtTOI(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function playerRow(p, rank) {
  const where = p.isHome ? "vs" : "@";
  return `<tr data-name="${esc(p.name.toLowerCase())} ${esc(p.team.toLowerCase())}">
  ${rank ? `<td class="rank">${rank}</td>` : ""}
  <td class="pl"><strong>${esc(p.name)}</strong><span class="meta">${esc(p.team)} · ${esc(p.pos)} · ${where} ${esc(p.opp)}</span></td>
  <td class="num prob"><span class="bar" style="width:${Math.round(Math.min(p.prob, 0.5) * 120)}px"></span>${pct(p.prob)}</td>
  <td class="num hide-sm">${p.goals} in ${p.gp}</td>
  <td class="num hide-sm">${p.shotsPG.toFixed(1)}</td>
  <td class="num hide-sm">${fmtTOI(p.toi)}</td>
</tr>`;
}

const FAQ = [
  [
    "How does this Hockey Challenge helper work?",
    "Every NHL game day, the page ranks every skater playing tonight by their estimated chance of scoring at least one goal. It uses each player's goals and shots per game this season, how many goals the opposing team allows (season and last 10 games), and home or away. Find the players from your 3 sets in the search box and pick the one with the highest chance from each set.",
  ],
  [
    "When is the page updated?",
    "Automatically, all day. Stats and the game list refresh every 30 minutes from NHL.com's public data. Nobody types anything in by hand.",
  ],
  [
    "How does the Tims NHL Hockey Challenge work?",
    "In the Tim Hortons app, on each NHL game day you make one pick from each of 3 sets of players. If a pick scores a goal in their game, you win a prize, and correct picks also count on the leaderboards.",
  ],
  [
    "Does a higher percentage guarantee a goal?",
    "No. Even the best goal scorers score in fewer than half of their games. The percentages show who is most likely to score, not who will. Always check injury news and starting lineups before you lock in your picks.",
  ],
  [
    "Why is a player missing from the list?",
    "Players need at least 3 games this season to be ranked. Recently called-up players and goalies are not included.",
  ],
  [
    "Is this site affiliated with Tim Hortons or the NHL?",
    "No. Hockey Pick Helper is an independent fan site. It is not affiliated with, endorsed by or connected to Tim Hortons, the NHL or any team.",
  ],
];

function renderPage({ date, games, players }, origin) {
  const short = fmtShortDate(date);
  const long = fmtDate(date);
  const title = `Tims Hockey Challenge Picks Today (${short}) – Best Picks Helper`;
  const desc = `Today's best Tims NHL Hockey Challenge picks for ${long}: every player in tonight's games ranked by chance to score, updated automatically.`;

  const top = players.slice(0, 15);
  const gamesHtml = games
    .map((g) => {
      const list = players.filter((p) => p.gameId === g.id).slice(0, 8);
      return `<details class="game">
  <summary><span>${esc(g.awayName)} <em>@</em> ${esc(g.homeName)}</span><span class="time">${fmtTime(g.start)}</span></summary>
  <table>${list.map((p) => playerRow(p, 0)).join("")}</table>
</details>`;
    })
    .join("");

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };

  const noGames = games.length === 0;

  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${origin}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${origin}/">
<script type="application/ld+json">${JSON.stringify(faqLd)}</script>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14181f;--muted:#5c6573;--line:#e3e6eb;--accent:#c8102e;--accent-soft:#fbe7ea;--good:#0b7a43}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--ink);color:#fff;padding:28px 16px 32px}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
header .wrap{padding:0}
.brand{font-weight:700;letter-spacing:.02em;font-size:14px;text-transform:uppercase;color:#ffb3bf}
h1{font-size:clamp(26px,5vw,38px);line-height:1.15;margin:8px 0 8px}
.sub{color:#c9cfd8;margin:0}
.updated{display:inline-block;margin-top:14px;font-size:13px;background:rgba(255,255,255,.1);padding:4px 10px;border-radius:99px}
main{margin-top:-14px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 18px}
h2{font-size:21px;margin:0 0 6px}
.lead{color:var(--muted);margin:0 0 14px;font-size:15px}
.search{width:100%;padding:12px 14px;font-size:16px;border:1px solid var(--line);border-radius:10px;margin-bottom:12px}
table{width:100%;border-collapse:collapse}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:0}
.rank{width:28px;color:var(--muted);font-weight:600}
.pl strong{display:block}
.meta{font-size:13px;color:var(--muted)}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
td.prob{font-weight:700}
.bar{display:inline-block;height:8px;background:var(--accent);border-radius:4px;margin-right:8px;vertical-align:middle;opacity:.85}
.game{border:1px solid var(--line);border-radius:10px;margin:0 0 10px;padding:0 12px}
.game summary{cursor:pointer;display:flex;justify-content:space-between;gap:8px;padding:12px 0;font-weight:600}
.game summary em{color:var(--muted);font-style:normal;margin:0 4px}
.time{color:var(--muted);font-weight:500;font-size:14px;white-space:nowrap}
.steps{padding-left:20px;margin:0}
.steps li{margin-bottom:6px}
.faq h3{font-size:16px;margin:16px 0 4px}
.faq p{margin:0;color:#333}
.note{background:var(--accent-soft);border-radius:10px;padding:12px 14px;font-size:14px}
footer{color:var(--muted);font-size:13px;padding:10px 0 40px}
@media (max-width:600px){.hide-sm{display:none}section{padding:16px}}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="brand">${SITE_NAME}</div>
  <h1>Tims NHL Hockey Challenge Helper: Today's Best Picks</h1>
  <p class="sub">Every player in tonight's NHL games, ranked by their chance to score. ${esc(long)}.</p>
  <span class="updated">Updates automatically every 30 minutes</span>
</div></header>

<main class="wrap">
${
  noGames
    ? `<section><h2>No NHL games scheduled</h2><p class="lead">There are no NHL games in the coming days. Check back on the next game day.</p></section>`
    : `<section id="find">
  <h2>Find your 3 picks</h2>
  <p class="lead">Type a player or team from each of your 3 sets in the app. Pick the player with the highest chance from each set.</p>
  <input class="search" id="q" type="search" placeholder="Search a player or team, e.g. McDavid or TOR" aria-label="Search players">
  <table id="all">
    <thead><tr><th>#</th><th>Player</th><th class="num">Chance to score</th><th class="num hide-sm">Goals</th><th class="num hide-sm">Shots/GP</th><th class="num hide-sm">TOI</th></tr></thead>
    <tbody>${players.map((p, i) => playerRow(p, i + 1)).join("")}</tbody>
  </table>
</section>

<section id="top">
  <h2>Top 15 most likely scorers tonight</h2>
  <p class="lead">The highest chances across all ${games.length} games on ${esc(short)}.</p>
  <table><tbody>${top.map((p, i) => playerRow(p, i + 1)).join("")}</tbody></table>
</section>

<section id="games">
  <h2>Tonight's games</h2>
  <p class="lead">Tap a game to see its 8 most likely scorers.</p>
  ${gamesHtml}
</section>`
}

<section id="how">
  <h2>How to use this helper</h2>
  <ol class="steps">
    <li>Open the Tims NHL Hockey Challenge in the Tim Hortons app and look at today's 3 sets of players.</li>
    <li>Search each player above, or scan the full ranking.</li>
    <li>From each set, choose the player with the highest chance to score.</li>
    <li>Check injury news and starting lineups before you lock in your picks.</li>
  </ol>
  <p class="note" style="margin-top:14px"><strong>How the chances are calculated:</strong> goals and shots per game this season, the opponent's goals against (season and last 10 games) and home ice. Players with fewer than 3 games are not ranked.</p>
</section>

<section id="faq" class="faq">
  <h2>Frequently asked questions</h2>
  ${FAQ.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join("")}
</section>

<footer>
  ${SITE_NAME} is an independent fan site and is not affiliated with, endorsed by or connected to Tim Hortons, the NHL or any NHL team. All trademarks belong to their owners. Statistics come from NHL.com's public data. Chances are estimates, not guarantees. Play responsibly.
</footer>
</main>

<script>
const q=document.getElementById('q');
if(q){const rows=[...document.querySelectorAll('#all tbody tr')];
q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();
rows.forEach(r=>{r.style.display=!v||r.dataset.name.includes(v)?'':'none'})})}
</script>
</body>
</html>`;
}

function renderError(origin) {
  return `<!doctype html><html lang="en-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tims Hockey Challenge Picks Today – ${SITE_NAME}</title><link rel="canonical" href="${origin}/"></head>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px">
<h1>Tims NHL Hockey Challenge Helper</h1>
<p>NHL stats are temporarily unavailable. Please refresh in a few minutes.</p></body></html>`;
}
