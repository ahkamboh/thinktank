/**
 * The thinktank dashboard single-page UI, served inline by the dashboard
 * server. Vanilla HTML/CSS/JS, zero external/CDN requests (privacy + offline).
 *
 * NOTE: this is one big template literal. To avoid clashing with the outer
 * literal, the embedded browser JS uses string concatenation rather than its
 * own template literals, and never contains a literal "</script>".
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>thinktank · memory dashboard</title>
<style>
  :root {
    --bg: #0a0b0f;
    --panel: #14151c;
    --panel-2: #1b1d27;
    --border: #262835;
    --text: #e7e9ef;
    --muted: #8b8fa3;
    --faint: #5a5e72;
    --accent: #ff6a2b;
    --accent-2: #7c5cff;
    --teal: #2dd4bf;
    --danger: #ef4444;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: radial-gradient(1200px 600px at 80% -10%, #16131f 0%, var(--bg) 55%);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    min-height: 100vh;
  }
  a { color: var(--accent-2); }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 22px 80px; }
  header.top { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  header.top h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  header.top .glyph { color: var(--accent); }
  header.top .dbpath { color: var(--faint); font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace; }

  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0 8px; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .stat .n { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .stat .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .stat.warn .n { color: var(--accent); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 18px; }
  .chip { background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-size: 12px; color: var(--muted); }
  .chip b { color: var(--text); font-weight: 600; }

  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .tab { background: none; border: none; color: var(--muted); padding: 10px 14px; cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }

  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; align-items: center; }
  input[type=search], select {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 10px; padding: 9px 12px; font-size: 13px; outline: none;
  }
  input[type=search] { flex: 1; min-width: 220px; }
  input[type=search]:focus, select:focus { border-color: var(--accent-2); }
  .btn { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 10px; padding: 9px 14px; cursor: pointer; font-size: 13px; }
  .btn:hover { border-color: var(--accent-2); }

  .list { display: flex; flex-direction: column; gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .card .text { white-space: pre-wrap; word-break: break-word; }
  .card .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; color: var(--faint); font-size: 12px; }
  .badge { border-radius: 6px; padding: 2px 8px; font-size: 11px; font-weight: 600; border: 1px solid var(--border); }
  .badge.kind { color: var(--teal); }
  .badge.src { color: var(--accent-2); }
  .badge.proj { color: var(--muted); }
  .badge.super { color: var(--accent); border-color: #4a2a16; }
  .spacer { flex: 1; }
  .iconbtn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 8px; padding: 4px 8px; cursor: pointer; font-size: 12px; }
  .iconbtn:hover { color: var(--danger); border-color: var(--danger); }
  select.kindsel { padding: 3px 6px; font-size: 11px; border-radius: 6px; }

  .contra { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .contra .row2 { display: grid; grid-template-columns: 1fr 24px 1fr; gap: 10px; align-items: center; }
  .contra .side { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .contra .side.active { border-color: #1f4a3a; }
  .contra .side .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .contra .side.active .lbl { color: var(--teal); }
  .contra .side.old .lbl { color: var(--accent); }
  .contra .arrow { text-align: center; color: var(--faint); font-size: 18px; }

  .pager { display: flex; gap: 10px; align-items: center; justify-content: center; margin-top: 22px; color: var(--muted); }
  .state { text-align: center; color: var(--faint); padding: 48px 0; }

  .import-help { color: var(--muted); font-size: 13px; line-height: 1.6; margin: 0 0 18px; max-width: 720px; }
  .import-help b { color: var(--text); font-weight: 600; }
  .import-grid { display: flex; flex-direction: column; gap: 14px; max-width: 720px; }
  .drop { border: 1.5px dashed var(--border); border-radius: var(--radius); background: var(--panel); padding: 30px 20px; text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
  .drop:hover { border-color: var(--accent-2); }
  .drop.drag { border-color: var(--accent); background: var(--panel-2); }
  .drop .big { font-size: 15px; color: var(--text); margin-bottom: 4px; }
  .drop .sub { font-size: 12px; color: var(--faint); }
  .drop .fname { color: var(--teal); font-size: 13px; margin-top: 10px; word-break: break-all; }
  .or { color: var(--faint); font-size: 12px; text-align: center; letter-spacing: .04em; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .field input[type=text], .field textarea {
    background: var(--panel); color: var(--text); border: 1px solid var(--border);
    border-radius: 10px; padding: 9px 12px; font-size: 13px; outline: none; width: 100%;
  }
  .field input[type=text]:focus, .field textarea:focus { border-color: var(--accent-2); }
  .field textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, SFMono-Regular, monospace; }
  .import-actions { display: flex; gap: 12px; align-items: center; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #160a04; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); border-color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .import-result { border-radius: var(--radius); border: 1px solid var(--border); padding: 14px 16px; background: var(--panel); }
  .import-result.ok { border-color: #1f4a3a; }
  .import-result.err { border-color: var(--danger); color: #fca5a5; }
  .import-result h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
  .sumgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
  .sumgrid .s { background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
  .sumgrid .s .n { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
  .sumgrid .s .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1><span class="glyph">&#9632;</span> thinktank</h1>
    <span class="dbpath" id="dbpath"></span>
  </header>

  <div class="stats" id="stats"></div>
  <div class="chips" id="chips"></div>

  <div class="tabs">
    <button class="tab active" data-tab="memories">Memories</button>
    <button class="tab" data-tab="contradictions">Contradictions</button>
    <button class="tab" data-tab="import">Import</button>
  </div>

  <section id="tab-memories">
    <div class="controls">
      <input type="search" id="q" placeholder="Search by meaning or keyword..." />
      <select id="f-project"><option value="">All projects</option></select>
      <select id="f-source"><option value="">All sources</option></select>
      <select id="f-kind"><option value="">All kinds</option></select>
      <select id="f-status">
        <option value="active">Active</option>
        <option value="superseded">Superseded</option>
        <option value="all">All</option>
      </select>
      <button class="btn" id="refresh">Refresh</button>
    </div>
    <div class="list" id="mem-list"></div>
    <div class="state hidden" id="mem-state"></div>
    <div class="pager">
      <button class="btn" id="prev">Prev</button>
      <span id="pageinfo">-</span>
      <button class="btn" id="next">Next</button>
    </div>
  </section>

  <section id="tab-contradictions" class="hidden">
    <div class="list" id="con-list"></div>
    <div class="state hidden" id="con-state"></div>
    <div class="pager">
      <button class="btn" id="cprev">Prev</button>
      <span id="cpageinfo">-</span>
      <button class="btn" id="cnext">Next</button>
    </div>
  </section>

  <section id="tab-import" class="hidden">
    <p class="import-help">
      Export your data from <b>ChatGPT</b> (Settings &rarr; Data controls &rarr; Export data) or
      <b>Claude</b> (Settings &rarr; Export data), then drop the <b>.zip</b> here &mdash; it is parsed
      locally on your machine and never leaves it. For a single chat instantly, use the
      <b>thinktank browser extension</b> instead.
    </p>
    <div class="import-grid">
      <div class="drop" id="drop">
        <input type="file" id="file" accept=".zip,.json,application/zip,application/json" hidden />
        <div class="big">Drop your export here</div>
        <div class="sub">a .zip (with conversations.json inside) or a conversations.json file &middot; or click to browse</div>
        <div class="fname hidden" id="fname"></div>
      </div>
      <div class="or">&mdash; or paste JSON &mdash;</div>
      <div class="field">
        <label for="paste">Paste export JSON</label>
        <textarea id="paste" placeholder="Paste the contents of conversations.json (an array of conversations)"></textarea>
      </div>
      <div class="field">
        <label for="proj">Project name</label>
        <input type="text" id="proj" value="web" />
      </div>
      <div class="import-actions">
        <button class="btn primary" id="doimport">Import</button>
        <span id="imp-status" class="or" style="text-align:left"></span>
      </div>
      <div class="import-result hidden" id="imp-result"></div>
    </div>
  </section>
</div>

<script>
(function () {
  var KINDS = ["decision","fact","preference","constraint","state","code"];
  var PAGE = 25;
  var memOffset = 0, memTotal = 0;
  var conOffset = 0, conTotal = 0;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function rel(ts) {
    if (!ts) return "-";
    var d = Date.now() - Number(ts);
    if (d < 0) d = 0;
    var s = Math.floor(d / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60); if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60); if (h < 24) return h + "h ago";
    var dd = Math.floor(h / 24); if (dd < 30) return dd + "d ago";
    var mo = Math.floor(dd / 30); if (mo < 12) return mo + "mo ago";
    return Math.floor(mo / 12) + "y ago";
  }
  function api(path, opts) {
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  function loadStats() {
    return api("/api/stats").then(function (s) {
      el("dbpath").textContent = s.dbPath || "";
      el("stats").innerHTML =
        statCard(s.total, "total", "") +
        statCard(s.active, "active", "") +
        statCard(s.superseded, "superseded", "") +
        statCard(s.contradictions, "contradictions", "warn");
      var chips = "";
      var kinds = (s.facets && s.facets.kinds) || [];
      for (var i = 0; i < kinds.length; i++) {
        chips += '<span class="chip"><b>' + esc(kinds[i].value) + "</b> " + kinds[i].count + "</span>";
      }
      var srcs = (s.facets && s.facets.tools) || [];
      for (var j = 0; j < srcs.length; j++) {
        chips += '<span class="chip">' + esc(srcs[j].value) + " <b>" + srcs[j].count + "</b></span>";
      }
      el("chips").innerHTML = chips;
      // Fill source filter from facet sources (the source column).
      var sel = el("f-source");
      if (sel.options.length <= 1 && s.facets && s.facets.sources) {
        for (var k = 0; k < s.facets.sources.length; k++) {
          var o = document.createElement("option");
          o.value = s.facets.sources[k].value;
          o.textContent = s.facets.sources[k].value + " (" + s.facets.sources[k].count + ")";
          sel.appendChild(o);
        }
      }
    });
  }
  function statCard(n, label, cls) {
    return '<div class="stat ' + (cls || "") + '"><div class="n">' +
      (n == null ? "-" : n) + '</div><div class="l">' + label + "</div></div>";
  }

  function loadProjects() {
    return api("/api/projects").then(function (r) {
      var sel = el("f-project");
      var ps = r.projects || [];
      for (var i = 0; i < ps.length; i++) {
        if (ps[i].project == null) continue;
        var o = document.createElement("option");
        o.value = ps[i].project;
        o.textContent = ps[i].project + " (" + ps[i].count + ")";
        sel.appendChild(o);
      }
    });
  }

  function memQuery() {
    var p = new URLSearchParams();
    var q = el("q").value.trim();
    if (q) p.set("query", q);
    if (el("f-project").value) p.set("project", el("f-project").value);
    if (el("f-source").value) p.set("source", el("f-source").value);
    if (el("f-kind").value) p.set("kind", el("f-kind").value);
    p.set("status", el("f-status").value);
    p.set("limit", PAGE);
    p.set("offset", memOffset);
    return p.toString();
  }

  function loadMemories() {
    el("mem-state").className = "state";
    el("mem-state").textContent = "Loading...";
    el("mem-list").innerHTML = "";
    return api("/api/memories?" + memQuery()).then(function (r) {
      memTotal = r.total || 0;
      var rows = r.rows || [];
      if (!rows.length) {
        el("mem-state").className = "state";
        el("mem-state").textContent = "No memories match these filters.";
      } else {
        el("mem-state").className = "state hidden";
      }
      var html = "";
      for (var i = 0; i < rows.length; i++) html += memCard(rows[i]);
      el("mem-list").innerHTML = html;
      var from = memTotal ? memOffset + 1 : 0;
      var to = Math.min(memOffset + PAGE, memTotal);
      el("pageinfo").textContent = from + "-" + to + " of " + memTotal;
      bindMemActions();
    });
  }

  function memCard(m) {
    var tool = (m.sources && m.sources.length && m.sources[0].tool) || m.tool || m.source;
    var sup = m.status === "superseded" ? '<span class="badge super">superseded</span>' : "";
    var opts = "";
    for (var i = 0; i < KINDS.length; i++) {
      opts += '<option value="' + KINDS[i] + '"' + (KINDS[i] === m.kind ? " selected" : "") + ">" + KINDS[i] + "</option>";
    }
    return '<div class="card" data-id="' + m.id + '">' +
      '<div class="text">' + esc(m.text) + "</div>" +
      '<div class="meta">' +
        '<select class="kindsel" data-id="' + m.id + '">' + opts + "</select>" +
        '<span class="badge src">' + esc(tool) + "</span>" +
        (m.project ? '<span class="badge proj">' + esc(m.project) + "</span>" : "") +
        sup +
        '<span>seen ' + (m.seenCount || 1) + "x</span>" +
        "<span>" + rel(m.lastSeen) + "</span>" +
        '<span class="spacer"></span>' +
        '<button class="iconbtn del" data-id="' + m.id + '">Delete</button>' +
      "</div></div>";
  }

  function bindMemActions() {
    var dels = document.querySelectorAll(".del");
    for (var i = 0; i < dels.length; i++) {
      dels[i].onclick = function () {
        var id = this.getAttribute("data-id");
        if (!confirm("Delete this memory? This cannot be undone.")) return;
        api("/api/memories/" + id, { method: "DELETE" }).then(function () {
          loadMemories(); loadStats();
        });
      };
    }
    var sels = document.querySelectorAll(".kindsel");
    for (var j = 0; j < sels.length; j++) {
      sels[j].onchange = function () {
        var id = this.getAttribute("data-id");
        var kind = this.value;
        api("/api/memories/" + id, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: kind })
        }).then(function () { loadStats(); });
      };
    }
  }

  function conQuery() {
    var p = new URLSearchParams();
    if (el("f-project").value) p.set("project", el("f-project").value);
    p.set("limit", PAGE);
    p.set("offset", conOffset);
    return p.toString();
  }

  function loadContradictions() {
    el("con-state").className = "state";
    el("con-state").textContent = "Loading...";
    el("con-list").innerHTML = "";
    return api("/api/contradictions?" + conQuery()).then(function (r) {
      conTotal = r.total || 0;
      var rows = r.rows || [];
      if (!rows.length) {
        el("con-state").className = "state";
        el("con-state").textContent = "No contradictions logged.";
      } else {
        el("con-state").className = "state hidden";
      }
      var html = "";
      for (var i = 0; i < rows.length; i++) html += conCard(rows[i]);
      el("con-list").innerHTML = html;
      var from = conTotal ? conOffset + 1 : 0;
      var to = Math.min(conOffset + PAGE, conTotal);
      el("cpageinfo").textContent = from + "-" + to + " of " + conTotal;
    });
  }

  function conCard(c) {
    return '<div class="contra"><div class="row2">' +
      '<div class="side active"><div class="lbl">Active &middot; ' + esc(c.activeSource || "?") + " &middot; " + rel(c.activeTs) + "</div>" +
        '<div class="text">' + esc(c.activeText) + "</div></div>" +
      '<div class="arrow">&#8594;</div>' +
      '<div class="side old"><div class="lbl">Superseded &middot; ' + esc(c.supersededSource || "?") + " &middot; " + rel(c.supersededTs) + "</div>" +
        '<div class="text">' + esc(c.supersededText) + "</div></div>" +
      "</div></div>";
  }

  // --- wiring ---
  function switchTab(name) {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].className = "tab" + (tabs[i].getAttribute("data-tab") === name ? " active" : "");
    }
    el("tab-memories").className = name === "memories" ? "" : "hidden";
    el("tab-contradictions").className = name === "contradictions" ? "" : "hidden";
    el("tab-import").className = name === "import" ? "" : "hidden";
    if (name === "contradictions") loadContradictions();
  }
  var tabBtns = document.querySelectorAll(".tab");
  for (var t = 0; t < tabBtns.length; t++) {
    tabBtns[t].onclick = function () { switchTab(this.getAttribute("data-tab")); };
  }

  var qTimer = null;
  el("q").oninput = function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { memOffset = 0; loadMemories(); }, 300);
  };
  el("f-project").onchange = function () { memOffset = 0; loadMemories(); };
  el("f-source").onchange = function () { memOffset = 0; loadMemories(); };
  el("f-kind").onchange = function () { memOffset = 0; loadMemories(); };
  el("f-status").onchange = function () { memOffset = 0; loadMemories(); };
  el("refresh").onclick = function () { loadStats(); loadMemories(); };
  el("prev").onclick = function () { if (memOffset >= PAGE) { memOffset -= PAGE; loadMemories(); } };
  el("next").onclick = function () { if (memOffset + PAGE < memTotal) { memOffset += PAGE; loadMemories(); } };
  el("cprev").onclick = function () { if (conOffset >= PAGE) { conOffset -= PAGE; loadContradictions(); } };
  el("cnext").onclick = function () { if (conOffset + PAGE < conTotal) { conOffset += PAGE; loadContradictions(); } };

  // kinds filter options
  (function () {
    var sel = el("f-kind");
    for (var i = 0; i < KINDS.length; i++) {
      var o = document.createElement("option");
      o.value = KINDS[i]; o.textContent = KINDS[i];
      sel.appendChild(o);
    }
  })();

  // --- import wiring ---
  var importFile = null;
  function setFile(f) {
    importFile = f || null;
    var fn = el("fname");
    if (importFile) {
      fn.textContent = "Selected: " + importFile.name + " (" + Math.max(1, Math.round(importFile.size / 1024)) + " KB)";
      fn.className = "fname";
    } else {
      fn.textContent = "";
      fn.className = "fname hidden";
    }
  }
  function sCard(n, label) {
    return '<div class="s"><div class="n">' + (n == null ? "-" : n) + '</div><div class="l">' + label + "</div></div>";
  }
  function showImportResult(ok, html) {
    var box = el("imp-result");
    box.className = "import-result " + (ok ? "ok" : "err");
    box.innerHTML = html;
  }
  function doImport() {
    var btn = el("doimport");
    var status = el("imp-status");
    var paste = el("paste").value.trim();
    var project = el("proj").value.trim() || "web";
    if (!importFile && !paste) {
      showImportResult(false, "<h3>Nothing to import</h3><div>Choose a .zip / .json file or paste JSON first.</div>");
      return;
    }
    var fd = new FormData();
    fd.append("project", project);
    if (importFile) fd.append("file", importFile);
    else fd.append("json", paste);

    btn.disabled = true;
    status.textContent = "Importing... parsing + embedding can take a moment.";
    el("imp-result").className = "import-result hidden";

    fetch("/api/import", { method: "POST", body: fd })
      .then(function (r) {
        return r.json().then(
          function (j) { return { status: r.status, body: j }; },
          function () { return { status: r.status, body: { ok: false, error: "Server returned a non-JSON response (HTTP " + r.status + ")." } }; }
        );
      })
      .then(function (res) {
        var j = res.body || {};
        if (!j.ok) {
          showImportResult(false, "<h3>Import failed</h3><div>" + esc(j.error || ("HTTP " + res.status)) + "</div>");
          return;
        }
        var cards =
          sCard(j.conversations, "conversations") +
          sCard(j.turns, "turns") +
          sCard(j.candidates, "candidates") +
          sCard(j.inserted, "new") +
          sCard(j.merged, "merged") +
          sCard(j.superseded, "updated") +
          sCard(j.contradictions, "conflicts");
        showImportResult(true,
          "<h3>Imported " + esc(j.source) + " export &middot; project &ldquo;" + esc(j.project) + "&rdquo; &middot; via " + esc(j.input) + "</h3>" +
          '<div class="sumgrid">' + cards + "</div>");
        setFile(null);
        el("file").value = "";
        el("paste").value = "";
        loadStats();
        loadMemories();
      })
      .catch(function (e) {
        showImportResult(false, "<h3>Import failed</h3><div>" + esc(String(e)) + "</div>");
      })
      .then(function () {
        btn.disabled = false;
        status.textContent = "";
      });
  }
  (function () {
    var drop = el("drop");
    var fileInput = el("file");
    if (!drop || !fileInput) return;
    drop.onclick = function () { fileInput.click(); };
    fileInput.onchange = function () { setFile(fileInput.files && fileInput.files[0]); };
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.className = "drop drag"; });
    drop.addEventListener("dragleave", function () { drop.className = "drop"; });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.className = "drop";
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        setFile(e.dataTransfer.files[0]);
      }
    });
    el("doimport").onclick = doImport;
  })();

  loadStats().then(loadProjects).then(loadMemories);
})();
</script>
</body>
</html>`;
