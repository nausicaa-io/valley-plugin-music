const CSS = `
.music-panel, .music-page, .music-menu, .music-cover-picker { font-family:var(--interface-font); }

/* ---- Shared cover thumbnail ------------------------------------------ */
.music-cover { border-radius:4px; object-fit:cover; flex-shrink:0; background:var(--container-color-light); }
.music-cover.artist { border-radius:50%; }
.music-cover-empty { display:grid; place-items:center; color:var(--text-tertiary); font-size:14px; }

/* ---- Left sidebar Music panel ---------------------------------------- */
.music-panel .panel-body { padding:0 0 12px; }
.music-empty { padding:16px 14px; color:var(--text-secondary); font-size:0.75rem; line-height:1.5; }
.music-empty.small { padding:6px 14px 10px; }
.music-empty code { font-size:0.6875rem; background:var(--container-color-light); border-radius:4px; padding:1px 4px; }

.music-info .props-info-value { overflow-wrap:anywhere; white-space:pre-wrap; }
.music-info-heading { margin:18px 0 8px; padding:0 var(--space-3, 12px); font-size:0.8125rem; font-weight:600; color:var(--text-color); }

/* ---- Settings --------------------------------------------------------- */
.music-settings-input { font-family:var(--mono-font, monospace); }
.music-settings-warning { color:var(--tint-red-text); }
.music-settings-positive { color:var(--tint-green-text); }
.music-settings-message { align-self:flex-end; color:var(--text-tertiary); font-size:var(--smaller-font-size); }

.music-results { display:flex; flex-direction:column; }
.music-results-label { padding:6px 5px 2px; font-size:0.6875rem; font-weight:600; text-transform:uppercase;
  letter-spacing:.03em; color:var(--text-tertiary); }

.music-section-head { position:relative; display:flex; align-items:center; gap:6px; width:100%;
  padding:6px 5px; background:none; border:none; color:var(--text-secondary); font-size:0.6875rem;
  font-weight:600; text-transform:uppercase; letter-spacing:.03em; cursor:pointer; }
.music-section-head:hover { color:var(--text-color); }
.music-section-title { flex:1; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.music-section-count { font-variant-numeric:tabular-nums; color:var(--text-tertiary); }
.music-section-body { display:flex; flex-direction:column; }
.music-section-action { border:none; background:none; color:var(--text-tertiary); cursor:pointer;
  font-size:13px; padding:2px 4px; display:grid; place-items:center; border-radius:4px; }
.music-section-action:hover { color:var(--text-color); background:var(--container-color-light); }

.music-row { display:flex; align-items:center; gap:8px; padding:4px 5px; cursor:pointer; }
.music-row:hover { background:var(--container-color-light); }
.music-row.active { background:var(--accent-tint-bg); }
.music-row.active .music-row-title { color:var(--accent-color); }
.music-row-play { position:relative; border:none; background:none; padding:0; cursor:pointer; flex-shrink:0; line-height:0; }
.music-row-playicon { position:absolute; inset:0; display:grid; place-items:center; color:#fff;
  background:rgba(0,0,0,.45); border-radius:4px; opacity:0; font-size:13px; }
.music-row-play:hover .music-row-playicon { opacity:1; }
.music-row-play.artist .music-row-playicon { border-radius:50%; }
.music-row-wave { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  gap:2px; background:rgba(0,0,0,.4); border-radius:4px; pointer-events:none; }
.music-row-wave-bar { width:3px; border-radius:1.5px; background:#fff;
  animation:music-wave .85s ease-in-out infinite alternate; }
.music-row-wave-bar:nth-child(1) { animation-delay:0s; }
.music-row-wave-bar:nth-child(2) { animation-delay:.2s; }
.music-row-wave-bar:nth-child(3) { animation-delay:.4s; }
@keyframes music-wave { 0% { height:4px; } 100% { height:14px; } }
.music-row-wave.paused .music-row-wave-bar { animation-play-state:paused; height:6px; }
.music-row-play:hover .music-row-wave { opacity:0; }
.music-row-meta { flex:1; display:flex; flex-direction:column; min-width:0; }
.music-row-title { font-size:0.8125rem; color:var(--text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.music-row-artist { font-size:0.6875rem; color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* ---- Clickable artist names (player / rows / cards) ------------------- */
.music-artist-names { color:inherit; }
.music-artist-link { color:inherit; cursor:pointer; border-radius:3px; }
.music-artist-link:hover { color:var(--accent-color); text-decoration:underline; }
.music-artist-link:focus-visible { outline:1.5px solid var(--accent-color); outline-offset:1px; }
.music-artist-sep { color:var(--text-tertiary); }
.music-row-dur { font-size:0.6875rem; color:var(--text-tertiary); font-variant-numeric:tabular-nums; flex-shrink:0; }
.music-row-fav { border:none; background:none; color:var(--text-tertiary); cursor:pointer; opacity:0; font-size:14px; padding:2px; }
.music-row:hover .music-row-fav, .music-row-fav.on { opacity:1; }
.music-row-fav.on { color:var(--accent-color); }
.music-row-fav.on svg { fill:currentColor; }
/* Brief highlight when the left panel reveals a song in the page's library list. */
@keyframes music-reveal-flash { 0% { background:var(--accent-tint-bg); } 100% { background:transparent; } }
.music-row.reveal-flash { animation:music-reveal-flash 1.2s ease-out; }
.music-row-missing { display:inline-flex; align-items:center; gap:3px; color:var(--tint-red-text, #b91c1c);
  font-size:0.625rem; flex-shrink:0; }
.music-row-missing svg { width:11px; height:11px; }

/* ---- Context menu (matches the core tree menu look) ------------------- */
.music-menu { position:fixed; z-index:1000; min-width:190px; padding:4px;
  background:var(--container-color-alt); border:1px solid var(--border-medium, rgba(128,128,128,.3));
  border-radius:8px; box-shadow:0 8px 30px rgba(0,0,0,.18); display:flex; flex-direction:column; }
.music-menu button { display:flex; align-items:center; gap:8px; width:100%; padding:5px 8px;
  border:none; background:none; color:var(--text-color); font-size:0.78125rem; text-align:left;
  border-radius:5px; cursor:pointer; }
.music-menu button:hover { background:var(--hover-bg); }
.music-menu button.danger { color:var(--tint-red-text, #b91c1c); }
.music-menu button svg { width:13px; height:13px; flex-shrink:0; color:var(--text-tertiary); }
.music-menu button.danger svg { color:inherit; }
.music-menu button:disabled { cursor:default; opacity:.55; }
.music-menu button:disabled:hover { background:none; }
.music-menu-sep { height:1px; margin:4px 6px; background:var(--border-light); }

/* ---- Playlist-header Edit dropdown ----------------------------------- */
.music-pl-edit { position:relative; display:inline-flex; }
.music-pl-edit-menu { position:absolute; top:calc(100% + 6px); left:0; min-width:150px; }

/* ---- New-playlist inline input -------------------------------------- */
.music-newpl { display:flex; gap:6px; padding:4px 5px 8px; }
.music-newpl input { flex:1; min-width:0; font-size:0.75rem; padding:4px 8px;
  border:1px solid var(--statusbar-border); border-radius:6px;
  background:var(--container-color-alt); color:var(--text-color); }
.music-newpl input:focus { outline:none; border-color:var(--accent-color); }

/* ---- Right sidebar full player --------------------------------------- */
.player-view { display:flex; flex-direction:column; align-items:stretch; text-align:center; gap:18px;
  padding:0 7px 18px; height:100%; min-height:0; box-sizing:border-box; overflow-y:auto; container-type:size; }
.player-now, .player-queue, .player-history { width:100%; max-width:none; }
.player-now { display:flex; flex-direction:column; align-items:center; gap:13px; flex-shrink:0; }
.player-media { display:flex; flex-direction:column; align-items:center; gap:5px; width:100%; }
.music-player-mode-row { display:flex; align-items:center; justify-content:center; width:100%; height:var(--app-bar-height); flex:none; box-sizing:border-box; border-bottom:1px solid transparent; }
.player-art { position:relative; container-type:size; width:100%; height:min(100cqw, max(0px, calc(100cqh - 230px))); flex:none; max-width:none; min-height:0; border-radius:2px; overflow:hidden; background:transparent; }
.player-art img, .player-art video { display:block; width:100%; height:100%; object-fit:contain; border-radius:2px; }
.player-art img { object-fit:cover; border-radius:10px; }
.player-art video { position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); width:min(100cqw, calc(100cqh * var(--music-video-ratio, 1.77777778))); height:auto; max-height:100%; border-radius:2px; }
.player-art > .player-error { position:absolute; bottom:0; left:0; margin:0; box-sizing:border-box; }
.player-art-empty { width:100%; height:100%; background:var(--container-color-light); display:grid; place-items:center; font-size:24px; color:var(--text-tertiary); }
.player-head { display:flex; align-items:flex-start; gap:10px; width:100%; }
.player-titles { flex:1; min-width:0; }
.player-title { font-size:1.1875rem; font-weight:650; margin:0 0 3px; color:var(--text-color); line-height:1.16; overflow-wrap:anywhere; }
.player-artist { margin:0; font-size:0.8125rem; color:var(--text-secondary); overflow-wrap:anywhere; }
.player-fav { border:none; background:none; color:var(--text-tertiary); cursor:pointer; font-size:20px; padding:2px; }
.player-fav.on { color:var(--accent-color); }
.player-fav.on svg { fill:currentColor; }
.player-scrub { display:flex; flex-direction:column; gap:5px; width:100%; padding:0; }
.player-times { display:flex; justify-content:space-between; font-size:0.625rem; color:var(--text-tertiary); font-variant-numeric:tabular-nums; }
.player-error { width:100%; padding:6px 8px; border-radius:6px; background:var(--tint-red-bg, rgba(239,68,68,.12));
  color:var(--tint-red-text, #b91c1c); font-size:0.6875rem; line-height:1.35; text-align:left; }
.player-controls { display:flex; align-items:center; justify-content:center; gap:20px; }
.player-controls button { border:none; background:none; color:var(--text-color); cursor:pointer; font-size:20px; display:grid; place-items:center; }
.player-playbtn { width:46px; height:46px; border-radius:50%; background:var(--text-color) !important;
  color:var(--container-color-alt) !important; font-size:21px !important; }
.player-playbtn:hover { opacity:.85; }
.player-playbtn svg { fill:currentColor; }
.player-playbtn.loading { pointer-events:none; }
.player-spinner { display:block; width:18px; height:18px; border-radius:50%;
  border:2px solid currentColor; border-top-color:transparent; animation:music-spin .7s linear infinite; }
.player-mode-btn { position:relative; color:var(--text-tertiary); font-size:16px !important; }
.player-mode-btn.active { color:var(--accent-color); }
.player-mode-btn.active::after { content:''; position:absolute; bottom:-6px; left:50%;
  transform:translateX(-50%); width:4px; height:4px; border-radius:50%; background:var(--accent-color); }

.player-queue, .player-history { display:flex; flex-direction:column; gap:6px;
  border-top:.5px solid var(--border-light); padding-top:10px; text-align:left; flex-shrink:0; }
.player-history { margin-bottom:4px; }
.player-queue-head { display:flex; align-items:center; justify-content:space-between; min-height:22px;
  gap:8px; width:100%; border:none; background:none; padding:0; cursor:pointer; border-radius:5px; }
.player-queue-head:hover { background:var(--hover-bg); }
.player-queue-head-right { display:flex; align-items:center; gap:6px; color:var(--text-tertiary); font-size:0.8125rem; }
.player-queue-label { display:flex; align-items:center; gap:6px; min-width:0; color:var(--text-secondary);
  font-size:0.6875rem; font-weight:650; text-transform:uppercase; }
.player-queue-label svg { width:13px; height:13px; flex-shrink:0; }
.player-queue-count { color:var(--text-tertiary); font-variant-numeric:tabular-nums; }
.player-queue-clear { border:none; background:transparent; color:var(--text-tertiary); cursor:pointer;
  font-size:0.6875rem; padding:2px 4px; border-radius:4px; }
.player-queue-clear:hover { background:var(--hover-bg); color:var(--text-color); }
.player-queue-list { display:flex; flex-direction:column; gap:1px; }
.player-queue-row, .player-history-row { display:flex; align-items:center; gap:7px; min-height:34px;
  padding:4px 3px; border-radius:6px; }
.player-history-row { padding-left:24px; }
.player-queue-row:hover, .player-history-row:hover { background:var(--hover-bg); }
.player-queue-row { position:relative; }
.player-queue-row.dragging { opacity:.45; }
/* The shared horizontal insertion marker (accent rule led by a ring), restated
   under this prefix — a plugin never borrows a core class. Geometry rides the
   --drop-* tokens so the queue matches every other reorderable list. */
.player-queue-row.drop-before::before { content:''; position:absolute; top:0; left:0; right:0;
  height:var(--drop-knob); margin-top:var(--drop-indicator-inset);
  background:var(--drop-indicator-fill); pointer-events:none; }
.player-queue-handle { display:grid; place-items:center; width:17px; color:var(--text-tertiary); cursor:grab; flex-shrink:0; }
.player-queue-cover { width:28px; height:28px; border-radius:4px; object-fit:cover; flex-shrink:0; background:var(--container-color-light); }
.player-queue-cover-empty { display:grid; place-items:center; color:var(--text-tertiary); font-size:12px; }
.player-queue-meta { flex:1; min-width:0; display:flex; flex-direction:column; border:none;
  background:transparent; padding:0; text-align:left; cursor:pointer; }
.player-queue-title, .player-queue-artist { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.player-queue-title { color:var(--text-color); font-size:0.75rem; }
.player-queue-artist { color:var(--text-tertiary); font-size:0.625rem; }
.player-queue-remove { border:none; background:transparent; color:var(--text-tertiary); cursor:pointer;
  display:grid; place-items:center; width:20px; height:20px; border-radius:4px; opacity:0; flex-shrink:0; }
.player-queue-row:hover .player-queue-remove { opacity:1; }
.player-queue-remove:hover { background:var(--hover-bg); color:var(--text-color); }
.player-queue-empty { padding:6px 3px 8px; color:var(--text-tertiary); font-size:0.6875rem; text-align:left; }

/* ---- Range inputs ----------------------------------------------------- */
.player-scrub input[type='range'], .music-page input[type='range'] {
  -webkit-appearance:none; appearance:none; height:14px; background:transparent; cursor:pointer; width:100%; }
.player-scrub input[type='range']::-webkit-slider-runnable-track,
.music-page input[type='range']::-webkit-slider-runnable-track {
  height:2px; border-radius:2px;
  background:linear-gradient(to right,
    var(--accent-color) var(--played, 0%),
    var(--container-color-light) var(--played, 0%)); }
.player-scrub input[type='range']::-webkit-slider-thumb,
.music-page input[type='range']::-webkit-slider-thumb {
  -webkit-appearance:none; appearance:none; width:10px; height:10px; border-radius:50%;
  background:var(--accent-color); margin-top:-4px; }

/* ---- The Music page (main workspace) ---------------------------------- */
.music-page { display:flex; flex-direction:column; height:100%; min-height:0; overflow-y:auto;
  background:var(--surface-color-alt); }
.music-page-header { position:sticky; top:0; z-index:5; flex:none; background:var(--surface-color-alt); }
.music-breadcrumbs { position:relative; display:flex; align-items:center; justify-content:space-between; gap:var(--space-1);
  height:var(--app-bar-height); box-sizing:border-box; border-bottom:var(--chrome-border-width) solid var(--border-light); flex:0 0 auto;
  padding:0 var(--space-button) 0 var(--space-row); font-size:0.8125rem; color:var(--text-secondary); user-select:none; }
.music-breadcrumb-items { position:absolute; left:50%; transform:translateX(-50%); display:flex; align-items:center; justify-content:center;
  width:max-content; max-width:max(0px, calc(100% - 170px)); min-width:0; overflow:hidden; gap:var(--space-tight); }
.music-breadcrumb-separator { color:var(--text-secondary); padding:0 var(--space-hairline); flex:0 0 auto; }
.music-breadcrumbs button { border:none; background:transparent; color:inherit; font:inherit; cursor:pointer;
  padding:var(--space-compact) var(--space-snug); border-radius:var(--radius-sm); white-space:nowrap; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; }
.music-breadcrumbs button.music-breadcrumb-home { flex:0 0 auto; padding:0 var(--space-hairline); color:var(--text-secondary); }
.music-breadcrumbs button[aria-current] { color:var(--title-color); flex-shrink:0; }
.music-breadcrumbs button:hover { background:var(--hover-bg); color:var(--title-color); }
.music-path-error { color:var(--tint-red-text); padding:4px 12px; }
.music-page-top { box-sizing:border-box; display:flex; align-items:center; gap:8px;
  height:var(--app-bar-height); flex:0 0 auto; padding:0 12px; background:var(--surface-color-alt);
  border-bottom:1px solid var(--border-light); }
.music-page-home { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;
  width:26px; height:26px; border-radius:6px; border:none; background:none;
  color:var(--text-secondary); cursor:pointer; }
.music-page-home:hover { background:var(--hover-bg); color:var(--text-color); }
.music-page-home svg { width:15px; height:15px; }
.music-page-more { display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;
  width:26px; height:26px; padding:0; border:0; border-radius:6px; background:none;
  color:var(--text-secondary); cursor:pointer; }
.music-page-more:hover { background:var(--hover-bg); color:var(--text-color); }
.music-page-more svg { width:16px; height:16px; }
.music-page-search { flex:1 1 0; }
@keyframes music-spin { to { transform:rotate(360deg); } }

.music-page-body { display:flex; flex-direction:column; gap:26px; padding:18px 22px 40px; }
.music-page-section { display:flex; flex-direction:column; gap:10px; }
.music-page-section-head { display:flex; align-items:center; gap:8px; color:var(--text-color); }
.music-page-section-head svg { width:15px; height:15px; color:var(--text-secondary); }
.music-page-section-head h2 { font-size:0.9375rem; font-weight:650; margin:0; flex:1; }
.music-page-section-head .count { color:var(--text-tertiary); font-size:0.75rem; font-variant-numeric:tabular-nums; }
.music-page-empty { color:var(--text-tertiary); font-size:0.78125rem; padding:2px 0 4px; }

/* Playlist card grid — Spotify-style, cover-forward, chromeless */
.music-pl-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:18px; }
.music-pl-card { position:relative; display:flex; flex-direction:column; gap:9px; padding:0;
  background:none; border:none; cursor:pointer; text-align:left; }
.music-pl-card-art { position:relative; width:100%; aspect-ratio:1; border-radius:0; overflow:hidden;
  background:var(--container-color-light); box-shadow:0 4px 16px rgba(0,0,0,.14); }
[data-theme="light"] .music-pl-card-art { background:#fff; }
.music-pl-card-art img { width:100%; height:100%; object-fit:cover; display:block; }
.music-pl-card-art-empty { width:100%; height:100%; display:grid; place-items:center;
  color:var(--text-tertiary); font-size:30px; }
.music-pl-card-play { position:absolute; right:10px; bottom:10px; width:42px; height:42px; border-radius:50%;
  border:none; display:grid; place-items:center; cursor:pointer;
  background:var(--accent-color); color:#fff; font-size:16px; opacity:0; transform:translateY(6px);
  transition:opacity .14s ease, transform .14s ease; box-shadow:0 6px 18px rgba(0,0,0,.35); }
.music-pl-card-play svg { fill:currentColor; }
.music-pl-card-play:hover { filter:brightness(1.08); }
.music-pl-card:hover .music-pl-card-play { opacity:1; transform:translateY(0); }
.music-pl-card-name { font-size:0.875rem; font-weight:650; color:var(--text-color); padding:0 2px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.music-pl-card-count { font-size:0.75rem; color:var(--text-tertiary); padding:0 2px; margin-top:-4px; }
.music-pl-card.active .music-pl-card-name { color:var(--accent-color); }
.music-pl-card.active .music-pl-card-play { opacity:1; transform:translateY(0); }

/* Now-playing equalizer badge (covers / cards) */
.music-card-eq { position:absolute; left:8px; bottom:8px; display:flex; align-items:flex-end; gap:2px;
  height:18px; pointer-events:none; filter:drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
.music-card-eq .music-row-wave-bar { width:2.5px; border-radius:1.5px; background:var(--accent-color);
  animation:music-wave .85s ease-in-out infinite alternate; }
.music-card-eq .music-row-wave-bar:nth-child(1) { animation-delay:0s; }
.music-card-eq .music-row-wave-bar:nth-child(2) { animation-delay:.2s; }
.music-card-eq .music-row-wave-bar:nth-child(3) { animation-delay:.4s; }
.music-card-eq.paused .music-row-wave-bar { animation-play-state:paused; height:7px; }
.music-pl-card-menu { position:absolute; top:8px; right:8px; width:24px; height:24px; border-radius:6px;
  border:none; display:grid; place-items:center; cursor:pointer; background:rgba(0,0,0,.45); color:#fff;
  font-size:13px; opacity:0; }
.music-pl-card:hover .music-pl-card-menu { opacity:1; }
.music-pl-card.new { gap:9px; }
.music-pl-card.new .music-pl-card-art { display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:7px; border:1px dashed var(--border-medium, rgba(128,128,128,.3));
  box-shadow:none; color:var(--text-secondary); }
.music-pl-card.new .music-pl-card-art:hover { background:var(--hover-bg); color:var(--text-color); }
[data-theme="light"] .music-pl-card.new .music-pl-card-art { background:var(--container-color-light); }
.music-pl-card.new svg { width:24px; height:24px; }
.music-pl-card.new span { font-size:0.78125rem; font-weight:600; }
.music-newpl-input { width:calc(100% - 24px); font-size:0.875rem; font-weight:600; text-align:center;
  padding:4px; border:none; background:none; color:var(--text-color); outline:none; }
.music-newpl-input::placeholder { color:var(--text-tertiary); font-weight:500; }

/* Horizontal track cards (recently played) — match the tiles */
.music-track-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:16px; }
.music-track-card { display:flex; flex-direction:column; gap:9px; padding:0;
  background:none; border:none; cursor:pointer; text-align:left; }
.music-track-card-art { position:relative; width:100%; aspect-ratio:1; border-radius:0; overflow:hidden;
  background:var(--container-color-light); box-shadow:0 4px 16px rgba(0,0,0,.14);
  display:grid; place-items:center; color:var(--text-tertiary); font-size:24px; }
[data-theme="light"] .music-track-card-art { background:#fff; }
.music-track-card-art img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.music-track-card-title { font-size:0.78125rem; font-weight:600; color:var(--text-color);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.music-track-card-sub { font-size:0.6875rem; color:var(--text-tertiary);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.music-track-card.active .music-track-card-title { color:var(--accent-color); }
.music-track-card-fav { position:absolute; top:8px; left:8px; width:26px; height:26px; border-radius:50%;
  border:none; display:grid; place-items:center; cursor:pointer; color:#fff; font-size:13px;
  background:rgba(0,0,0,.45); opacity:0; transition:opacity .12s ease;
  filter:drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
.music-track-card:hover .music-track-card-fav { opacity:1; }
.music-track-card-fav.on { opacity:1; color:var(--accent-color); background:rgba(0,0,0,.45); }
.music-track-card-fav.on svg { fill:currentColor; }

/* Most-listened rows */
.music-top-row { display:flex; align-items:center; gap:10px; padding:5px 6px; border-radius:8px; cursor:pointer; }
.music-top-row:hover { background:var(--hover-bg); }
.music-top-row.active { background:var(--accent-tint-bg); }
.music-top-row.active .music-row-title { color:var(--accent-color); }
.music-top-cover { position:relative; display:flex; flex-shrink:0; }
.music-top-cover .music-card-eq { left:50%; bottom:50%; transform:translate(-50%, 50%);
  height:14px; padding:3px 4px; gap:1.5px; }
.music-top-rank { width:22px; text-align:right; color:var(--text-tertiary); font-size:0.78125rem;
  font-variant-numeric:tabular-nums; font-weight:600; flex-shrink:0; }
.music-top-plays { color:var(--text-tertiary); font-size:0.71875rem; font-variant-numeric:tabular-nums; flex-shrink:0; }

/* Playlist detail */
.music-pl-detail-head { display:flex; align-items:center; gap:12px; }
.music-pl-detail-art { position:relative; width:168px; height:168px; border-radius:10px; overflow:hidden;
  background:var(--container-color-light); flex-shrink:0; box-shadow:0 10px 30px rgba(0,0,0,.14); }
.music-pl-detail-art img { width:100%; height:100%; object-fit:cover; display:block; }
.music-pl-detail-art-empty { width:100%; height:100%; display:grid; place-items:center;
  color:var(--text-tertiary); font-size:34px; }
.music-pl-detail-art button { position:absolute; inset:auto 0 0 0; padding:6px; border:none;
  display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;
  background:rgba(0,0,0,.55); color:#fff; font-size:0.71875rem; font-weight:600; opacity:0; }
.music-pl-detail-art:hover button { opacity:1; }
.music-pl-detail-art.dragover { box-shadow:0 0 0 2px var(--accent-color), 0 10px 30px rgba(0,0,0,.14); }
.music-pl-detail-art.dropmiss { box-shadow:0 0 0 2px var(--tint-red-text, #b91c1c), 0 10px 30px rgba(0,0,0,.14); }
.music-pl-detail-drop { position:absolute; inset:0; display:grid; place-items:center; text-align:center;
  padding:10px; font-size:0.75rem; font-weight:600; color:#fff; background:rgba(0,0,0,.5);
  pointer-events:none; }
.music-pl-detail-art.dropmiss .music-pl-detail-drop { background:rgba(120,20,20,.55); }
.music-pl-detail-info { display:flex; flex-direction:column; gap:8px; min-width:0; }
.music-pl-detail-kicker { font-size:0.6875rem; font-weight:650; text-transform:uppercase;
  letter-spacing:.04em; color:var(--text-secondary); }
.music-pl-detail-name { font-size:1.625rem; font-weight:750; color:var(--text-color); margin:0;
  cursor:text; border-radius:6px; padding:1px 4px; margin-left:-4px; overflow-wrap:anywhere; }
.music-pl-detail-name:hover { background:var(--hover-bg); }
.music-pl-detail-name-input { font-size:1.625rem; font-weight:750; color:var(--text-color);
  background:var(--container-color-alt); border:1px solid var(--accent-color); border-radius:6px;
  padding:0 4px; margin-left:-4px; outline:none; width:100%; max-width:480px; }
.music-pl-detail-meta { font-size:0.78125rem; color:var(--text-tertiary); }
.music-pl-detail-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:4px; }
.music-pl-detail-actions .primary { display:inline-flex; align-items:center; justify-content:center;
  width:46px; height:46px; padding:0; border:none; border-radius:50%; background:var(--accent-color);
  color:#fff; cursor:pointer; }
.music-pl-detail-actions .primary svg { fill:currentColor; width:18px; height:18px; }
.music-pl-detail-actions .primary:hover { filter:brightness(1.08); }
.music-pl-detail-actions .primary:disabled { opacity:.5; cursor:default; filter:none; }
.music-pl-detail-actions .ghost { display:inline-flex; align-items:center; gap:6px; padding:7px 12px;
  border:1px solid var(--border-medium, rgba(128,128,128,.3)); border-radius:999px; background:none;
  color:var(--text-secondary); font-size:0.75rem; font-weight:600; cursor:pointer; white-space:nowrap; }
.music-pl-detail-actions .ghost:hover { background:var(--hover-bg); color:var(--text-color); }
.music-pl-detail-actions .ghost.active { background:var(--accent-tint-bg); color:var(--accent-tint-text);
  border-color:var(--accent-color); }
.music-pl-detail-actions .ghost.danger { color:var(--tint-red-text, #b91c1c); border-color:var(--tint-red-text, #b91c1c); }
.music-page-back { display:inline-flex; align-items:center; gap:5px; align-self:flex-start; padding:5px 8px 5px 0;
  border:none; border-radius:6px; background:none; color:var(--text-secondary); font-size:0.78125rem;
  font-weight:600; cursor:pointer; }
.music-page-back:hover { color:var(--text-color); }

/* Artist detail — reuses the playlist-detail head, with a round portrait */
.music-artist-art { border-radius:50%; }
.music-artist-art .music-pl-detail-art-empty { font-size:48px; }
.music-artist-bio { margin:2px 0 0; font-family:var(--body-font); font-size:0.78125rem; line-height:1.5; color:var(--text-secondary);
  max-width:640px; white-space:pre-wrap; }
.music-artist-edit { display:flex; flex-direction:column; gap:10px; margin-top:8px; max-width:520px; }
.music-artist-bio-input { width:100%; min-height:64px; resize:vertical; font-family:var(--body-font); font-size:0.78125rem;
  line-height:1.5; padding:8px 10px; border-radius:8px; color:var(--text-color);
  background:var(--container-color-alt); border:1px solid var(--border-medium, rgba(128,128,128,.3)); outline:none; }
.music-artist-bio-input:focus { border-color:var(--accent-color); }
.music-artist-merge { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.music-artist-merge label { font-size:0.6875rem; font-weight:650; text-transform:uppercase; letter-spacing:.03em;
  color:var(--text-secondary); }
.music-artist-merge select { flex:1; min-width:140px; font-size:0.78125rem; padding:6px 8px; border-radius:8px;
  color:var(--text-color); background:var(--container-color-alt);
  border:1px solid var(--border-medium, rgba(128,128,128,.3)); outline:none; }
.music-artist-merge select:focus { border-color:var(--accent-color); }

.music-song-list { display:flex; flex-direction:column; gap:1px; }
.music-pl-row { position:relative; }
.music-pl-row.dragging { opacity:.45; }
/* Same marker as the queue: an inset shadow cannot carry the ring, so the seam
   draws as a pseudo-element on the --drop-* tokens. */
.music-pl-row.drop-before::before { content:''; position:absolute; top:0; left:0; right:0;
  height:var(--drop-knob); margin-top:var(--drop-indicator-inset);
  background:var(--drop-indicator-fill); pointer-events:none; }
.music-row-handle, .music-row-remove { border:none; background:none; color:var(--text-tertiary);
  cursor:pointer; font-size:14px; padding:2px; opacity:0; flex-shrink:0; }
.music-row:hover .music-row-handle, .music-row:hover .music-row-remove { opacity:1; }
.music-row-handle { cursor:grab; }
.music-row-add { border:none; background:none; color:var(--text-tertiary); cursor:pointer;
  font-size:14px; padding:2px; flex-shrink:0; }
.music-row-add:hover { color:var(--accent-color); }

/* ---- Cover picker modal ----------------------------------------------- */
.music-cover-picker-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.4);
  display:grid; place-items:center; z-index:1000; }
.music-cover-picker { width:min(680px, 92vw); max-height:80vh; background:var(--container-color-alt);
  border:2px solid var(--border-medium, rgba(128,128,128,.3)); border-radius:8px;
  box-shadow:0 12px 48px rgba(0,0,0,.3); display:flex; flex-direction:column; overflow:hidden; }
.music-cover-picker.dragover { border-color:var(--accent-color); }
.music-cover-picker-head { display:flex; align-items:center; justify-content:space-between;
  padding:16px 20px; font-size:0.9375rem; font-weight:650; color:var(--text-color); }
.music-cover-picker-head button { border:none; background:none; color:var(--text-tertiary); cursor:pointer;
  font-size:16px; display:grid; place-items:center; width:28px; height:28px; border-radius:6px; }
.music-cover-picker-head button:hover { background:var(--hover-bg); color:var(--text-color); }
.music-cover-search { width:calc(100% - 2 * var(--space-5)); margin:0 var(--space-5) var(--space-3); }
.music-cover-grid { display:grid; grid-template-columns:repeat(3, 1fr);
  gap:2px; padding:2px 20px 20px; overflow-y:auto; }
.music-cover-grid button { position:relative; align-self:start; border:none; background:var(--container-color-light);
  padding:0 0 100% 0; cursor:pointer; border-radius:0; overflow:hidden; display:block; width:100%; height:0; }
.music-cover-grid button::after { content:''; position:absolute; inset:0; pointer-events:none;
  outline:2px solid transparent; outline-offset:-2px; transition:outline-color .1s ease; }
.music-cover-grid button:hover::after { outline-color:var(--accent-color); }
.music-cover-grid button.selected::after { outline-color:var(--accent-color); }
.music-cover-grid img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
.music-cover-first .music-cover-first-inner { position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:7px; padding:8px; text-align:center;
  font-size:0.6875rem; font-weight:600; line-height:1.25; }
.music-cover-first .music-cover-first-inner svg { width:20px; height:20px; }
.music-cover-first--drop { background:var(--container-color-light); }
.music-cover-first--drop .music-cover-first-inner { color:var(--text-secondary);
  border:2px dashed var(--border-medium, rgba(128,128,128,.5)); }
.music-cover-first--drop.dragover { background:var(--accent-tint-bg); }
.music-cover-first--drop.dragover .music-cover-first-inner { color:var(--accent-color);
  border-color:var(--accent-color); }
.music-cover-first--remove { background:var(--tint-red-bg, rgba(185,28,28,.08)); }
.music-cover-first--remove .music-cover-first-inner { color:var(--tint-red-text, #b91c1c); }
.music-cover-first--remove:hover { background:var(--tint-red-bg, rgba(185,28,28,.16)); }
.music-cover-grid figcaption { position:absolute; inset:auto 0 0 0; padding:5px 6px 4px; font-size:0.59375rem;
  color:#fff; background:linear-gradient(transparent, rgba(0,0,0,.75)); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; opacity:0; transition:opacity .1s ease; }
.music-cover-grid button:hover figcaption,
.music-cover-grid button.selected figcaption { opacity:1; }
.music-cover-picker-empty { padding:22px 20px; color:var(--text-tertiary); font-size:0.78125rem; }

.music-song-editor { font-family:var(--interface-font); }
.music-song-editor fieldset { border:0; margin:0; padding:0; min-width:0; }
.music-edit-help { color:var(--text-secondary); margin:0 0 16px; }
.music-edit-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.music-song-editor label { display:flex; flex-direction:column; gap:5px; font-size:var(--font-ui-small); min-width:0; }
.music-song-editor input:not([type=file]), .music-song-editor textarea { width:100%; box-sizing:border-box; padding:7px 9px; border:1px solid var(--border-light); border-radius:var(--radius-sm,4px); background:var(--input-bg,var(--surface-color-alt)); color:var(--text-color); font:inherit; }
.music-song-editor textarea { min-height:68px; resize:vertical; margin-bottom:12px; }
.music-song-editor fieldset > label { margin-top:12px; }
.music-edit-cover { display:flex; align-items:flex-end; flex-wrap:wrap; gap:8px; }
.music-edit-cover img { width:64px; height:64px; object-fit:cover; border-radius:4px; }
.music-edit-cover label { flex:1; min-width:140px; }
.music-edit-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
.music-song-editor button { border:1px solid var(--border-light); border-radius:4px; padding:6px 10px; background:var(--surface-color-alt); color:var(--text-color); cursor:pointer; }
.music-song-editor button.primary { background:var(--accent-color); color:var(--accent-button-text); border-color:transparent; }
.music-song-editor button:disabled { opacity:.5; cursor:default; }
.music-song-editor [role=alert] { color:var(--text-error,var(--tint-red-text)); }
.music-now-playing { display:flex; align-items:center; gap:6px; min-width:0; max-width:240px; height:calc(var(--footer-control-height,24px) - 2px); padding:0 1px; border:0; border-radius:2px; background:none; color:var(--text-color); font:inherit; font-size:calc(1em - 1px); cursor:pointer; }
.music-now-playing:focus-visible, .music-video-mode button:focus-visible, .music-breadcrumbs button:focus-visible { outline:2px solid var(--accent-color); outline-offset:-2px; }
.music-now-playing img { flex:none; width:18px; height:18px; object-fit:cover; border-radius:3px; }
.music-now-playing span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.music-video-mode { display:inline-flex; justify-content:center; height:var(--search-field-height); box-sizing:border-box; padding:2px; border-radius:999px; background:var(--container-color-light); }
.music-video-mode button { border:0; border-radius:999px; min-width:72px; height:100%; padding:0 16px; font:inherit; font-weight:600; color:var(--text-secondary); background:transparent; cursor:pointer; }
.music-video-mode button:hover { color:var(--text-color); }
.music-video-mode button[aria-pressed=true] { color:var(--text-color); background:var(--hover-bg); }

`

const STYLE_ID = 'notes-music-styles'

/** Inject (or refresh, on hot reload) the plugin stylesheet. */
export function injectStyles(): () => void {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = CSS
  return () => {
    if (document.getElementById(STYLE_ID) === el) el.remove()
  }
}
