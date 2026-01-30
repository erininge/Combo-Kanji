(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const APP_VERSION = "1.0.1";
  const BUILD = "b7f2c9e1f0";

  const STORAGE = {
    stars: "jlptck_stars_v1",
    stats: "jlptck_stats_v1",
    settings: "jlptck_settings_v1",
    data: "jlptck_data_v1",
    multiTypingOff: "jlptck_multi_typing_off_v1"
  };

  const defaultSettings = () => ({
    showReadings: "off",
    mcCount: 4,
    multiTyping: "on",
    studyLevel: "all",
    studyLessons: null, // null means "all checked"
    viewLevel: "all",
    viewLesson: "all"
  });

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  let DATA = null;
  let items = [];

  async function loadData() {
    const stored = loadJSON(STORAGE.data, null);
    if (stored && stored.items) return stored;
    const res = await fetch("data/kanji.json");
    return await res.json();
  }

  let settings = loadJSON(STORAGE.settings, defaultSettings());
  let starred = new Set(loadJSON(STORAGE.stars, []));
  let multiTypingOff = new Set(loadJSON(STORAGE.multiTypingOff, []));

  function isStarred(id) { return starred.has(id); }
  function toggleStar(id) {
    if (starred.has(id)) starred.delete(id); else starred.add(id);
    saveJSON(STORAGE.stars, Array.from(starred));
    renderStarsUI();
    if (!$("#tab-view").classList.contains("hidden")) renderKanjiList();
    if (!$("#tab-stats").classList.contains("hidden")) renderStats();
  }

  function renderStarsUI() {
    const btn = $("#btnStar");
    if (btn && current) btn.textContent = isStarred(current.id) ? "★" : "☆";
    const quick = $("#btnQuickStar");
    if (quick && current) quick.textContent = isStarred(current.id) ? "★ Star" : "☆ Star";
  }

  let stats = loadJSON(STORAGE.stats, {
    total: 0, correct: 0, wrong: 0, streakBest: 0,
    byId: {}, byLesson: {}
  });
  function ensureObj(map, key, init) { if (!map[key]) map[key] = init(); return map[key]; }
  function lessonKey(item) { return `${item.category || "?"}-${item.section || "?"}`; }
  function markStat(item, ok) {
    stats.total += 1;
    if (ok) stats.correct += 1; else stats.wrong += 1;

    const s1 = ensureObj(stats.byId, item.id, () => ({c:0,w:0}));
    if (ok) s1.c += 1; else s1.w += 1;

    const lk = lessonKey(item);
    const s2 = ensureObj(stats.byLesson, lk, () => ({c:0,w:0}));
    if (ok) s2.c += 1; else s2.w += 1;

    saveJSON(STORAGE.stats, stats);
  }

  function setTab(tab) {
    $$(".tab").forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    ["study","view","stats","settings"].forEach(t => {
      $("#tab-"+t).classList.toggle("hidden", t !== tab);
    });
    if (tab === "view") renderKanjiList();
    if (tab === "stats") renderStats();
    if (tab === "settings") renderSettings();
  }
  $$(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // Session state
  let session = null;
  let queue = [], idx = 0, streak = 0;
  let current = null;
  let locked = false;

  function shuffle(a) {
    for (let i=a.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [a[i],a[j]]=[a[j],a[i]];
    }
    return a;
  }
  function clampInt(v, min, max) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
  }
  function pickMode(selMode) { return selMode !== "mixed" ? selMode : (Math.random()<0.5 ? "k2m":"m2k"); }
  function pickAnswerType(selAnswer) { return selAnswer !== "mixed" ? selAnswer : (Math.random()<0.5 ? "mc":"typing"); }

  // ---- Smart grading (meaning typing)
  function stripParens(s) { return String(s).replace(/\([^)]*\)/g, " "); }
  function normalizeMeaning(s) {
    return stripParens(String(s))
      .replace(/[“”"']/g, "")
      .replace(/[.,!?;:\/\\\-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  function normalizeKanjiAnswer(s) { return String(s).trim().replace(/\s+/g,""); }
  function splitMeanings(meaning) {
    return String(meaning)
      .split(/;|,/)
      .map(part => part.trim())
      .filter(Boolean);
  }

  function hasMultipleMeanings(item) { return splitMeanings(item.meaning).length > 1; }
  function isMultiTypingActive(item, mode) {
    if (mode !== "k2m") return false;
    if (settings.multiTyping !== "on") return false;
    if (!hasMultipleMeanings(item)) return false;
    return !multiTypingOff.has(item.id);
  }

  // ---- Filters (Study: N level + multi lessons)
  let lessonIndex = null; // { levels: ["N5"...], byLevel: {N5:[1,2..]}, allPairs:[{lvl,sec}...] }

  function buildLessonIndex() {
    const byLevel = {};
    items.forEach(it => {
      const lvl = it.category || it.jlpt_level || "Unknown";
      const sec = parseInt(it.section, 10);
      if (!lvl || Number.isNaN(sec)) return;
      if (!byLevel[lvl]) byLevel[lvl] = new Set();
      byLevel[lvl].add(sec);
    });
    const levels = ["N5","N4","N3","N2","N1"].filter(l => byLevel[l]);
    const outByLevel = {};
    levels.forEach(l => outByLevel[l] = Array.from(byLevel[l]).sort((a,b)=>a-b));
    const allPairs = [];
    levels.forEach(l => outByLevel[l].forEach(sec => allPairs.push({lvl:l, sec})));
    lessonIndex = { levels, byLevel: outByLevel, allPairs };
  }

  function getStudyLevel() { return $("#selLevel")?.value || settings.studyLevel || "all"; }

  function getCheckedLessonKeys() {
    const boxes = $$("#lessonChecks input[type=checkbox]");
    return boxes.filter(b => b.checked).map(b => b.value);
  }

  function updateLessonSummary() {
    const summary = $("#lessonSummaryCount");
    if (!summary) return;
    const boxes = $$("#lessonChecks input[type=checkbox]");
    const total = boxes.length;
    const checked = boxes.filter(b => b.checked).length;
    if (!total) {
      summary.textContent = "No lessons";
      return;
    }
    summary.textContent = checked === total ? `All (${total})` : `${checked}/${total} selected`;
  }

  function persistStudyLessonState() {
    settings.studyLevel = getStudyLevel();
    settings.studyLessons = getCheckedLessonKeys();
    saveJSON(STORAGE.settings, settings);
    updateLessonSummary();
  }

  function setAllLessonsChecked(checked) {
    $$("#lessonChecks input[type=checkbox]").forEach(b => b.checked = checked);
    persistStudyLessonState();
  }

  function renderStudyLessons(resetToAll=false) {
    const level = getStudyLevel();
    const host = $("#lessonChecks");
    if (!host) return;
    host.innerHTML = "";

    if (!lessonIndex) return;

    const restoreSet = (!resetToAll && Array.isArray(settings.studyLessons)) ? new Set(settings.studyLessons) : null;

    const makeBox = (val, label) => {
      const wrap = document.createElement("label");
      wrap.innerHTML = `<input type="checkbox" value="${val}" /> <span>${label}</span>`;
      const cb = wrap.querySelector("input");
      cb.checked = restoreSet ? restoreSet.has(val) : true;
      cb.addEventListener("change", () => persistStudyLessonState());
      host.appendChild(wrap);
    };

    if (level === "all") {
      lessonIndex.allPairs.forEach(p => {
        const val = `${p.lvl}|${p.sec}`;
        makeBox(val, `${p.lvl} L${p.sec}`);
      });
    } else {
      (lessonIndex.byLevel[level] || []).forEach(sec => {
        const val = `${level}|${sec}`;
        makeBox(val, `L${sec}`);
      });
    }

    persistStudyLessonState();
  }

  function syncStudyUIFromSettings() {
    if ($("#selLevel")) $("#selLevel").value = settings.studyLevel || "all";
    renderStudyLessons(false);
  }

  function getPool() {
    const level = getStudyLevel();
    const starOnly = $("#chkStarOnly")?.checked;
    const selectedLessonKeys = new Set(getCheckedLessonKeys());

    let pool = items;

    if (level !== "all") pool = pool.filter(x => (x.category || x.jlpt_level) === level);

    // If none checked, empty pool (explicit choice)
    if (selectedLessonKeys.size) {
      pool = pool.filter(x => selectedLessonKeys.has(`${(x.category||x.jlpt_level||"Unknown")}|${x.section}`));
    } else {
      pool = [];
    }

    if (starOnly) pool = pool.filter(x => isStarred(x.id));
    return pool.slice();
  }

  function autoQuestionCount(len) { return Math.max(5, Math.min(20, len)); }

  function startSession() {
    const pool = getPool();
    if (!pool.length) {
      alert("No items in that selection. (If Starred only is on, star something first.)");
      return;
    }
    const selMode = $("#selMode").value;
    const selAnswer = $("#selAnswer").value;
    const mcCount = parseInt(settings.mcCount, 10) || 4;

    const qCount = $("#chkAuto").checked ? autoQuestionCount(pool.length) : clampInt($("#numQ").value, 5, 200);
    const usePool = shuffle(pool.slice());
    queue = [];
    while (queue.length < qCount) queue.push(...usePool);
    queue = queue.slice(0, qCount);

    session = { selMode, selAnswer, mcCount, total: qCount, curMode: "k2m", curAnswerType: "mc", mcPack: null };
    idx = 0; streak = 0; locked = false;

    $("#studySetup").classList.add("hidden");
    $("#studySession").classList.remove("hidden");
    nextQuestion();
  }

  function stopSession() {
    session = null; queue = []; current = null;
    $("#studySetup").classList.remove("hidden");
    $("#studySession").classList.add("hidden");
    $("#feedback").textContent = ""; $("#feedback").className = "feedback";
    $("#btnNext").disabled = true;
    $$("#typingInputs input").forEach(input => { input.value = ""; });
    locked = false;
  }

  function setPrompt(mode, item) {
    const showReadings = settings.showReadings === "on";
    if (mode === "k2m") {
      $("#promptMain").textContent = item.kanji;
      $("#promptSub").textContent = showReadings ? `読み: ${(item.readings||[]).join(" / ")}` : "";
    } else {
      $("#promptMain").textContent = item.meaning;
      $("#promptSub").textContent = "";
    }
  }

  function buildChoices(mode, item, count) {
    const correct = mode === "k2m" ? item.meaning : item.kanji;
    const field = mode === "k2m" ? "meaning" : "kanji";
    const distractors = shuffle(items.filter(x => x.id !== item.id)).slice(0, Math.max(0, count-1));
    const opts = shuffle([correct, ...distractors.map(x => x[field])]).slice(0, count);
    if (!opts.includes(correct)) opts[Math.floor(Math.random()*opts.length)] = correct;
    return { correct, options: opts };
  }

  function escapeHtml(s) {
    return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
  }

  function renderAnswerUI(answerType, mcPack=null) {
    $("#mcArea").classList.toggle("hidden", answerType !== "mc");
    $("#typingArea").classList.toggle("hidden", answerType !== "typing");

    $("#btnNext").disabled = true;
    $("#feedback").textContent = "";
    $("#feedback").className = "feedback";
    locked = false;

    if (answerType === "mc") {
      const host = $("#mcGrid"); host.innerHTML = "";
      const labels = ["1","2","3","4"];
      mcPack.options.forEach((opt, i) => {
        const btn = document.createElement("button");
        btn.className = "mcBtn";
        btn.dataset.option = opt;
        btn.innerHTML = `<div class="mcLbl">${labels[i]||""}</div><div class="mcText">${escapeHtml(opt)}</div>`;
        btn.addEventListener("click", () => checkMC(i, mcPack));
        host.appendChild(btn);
      });
    } else {
      renderTypingInputs();
    }
  }

  function nextQuestion() {
    if (!session) return;
    if (idx >= queue.length) {
      $("#sessionProgress").textContent = "Done 🎉";
      $("#promptMain").textContent = "Session complete";
      $("#promptSub").textContent = "";
      $("#mcArea").classList.add("hidden");
      $("#typingArea").classList.add("hidden");
      $("#feedback").textContent = "";
      $("#btnNext").disabled = true;
      current = null;
      return;
    }

    current = queue[idx];
    const mode = pickMode(session.selMode);
    const answerType = pickAnswerType(session.selAnswer);
    session.curMode = mode;
    session.curAnswerType = answerType;

    $("#sessionProgress").textContent = `Question ${idx+1}/${session.total} • Streak ${streak}`;
    setPrompt(mode, current);
    renderStarsUI();

    if (answerType === "mc") {
      const pack = buildChoices(mode, current, session.mcCount);
      session.mcPack = pack;
      renderAnswerUI("mc", pack);
    } else {
      session.mcPack = null;
      renderAnswerUI("typing");
    }
  }

  function markFeedback(ok, extra="") {
    const fb = $("#feedback");
    fb.textContent = ok ? `✅ Correct${extra ? " • "+extra : ""}` : `❌ Not quite${extra ? " • "+extra : ""}`;
    fb.className = ok ? "feedback good" : "feedback bad";
  }

  function checkMC(i, pack) {
    if (!session || locked) return;
    const chosen = pack.options[i];
    const ok = chosen === pack.correct;
    locked = true;

    const buttons = $$("#mcGrid .mcBtn");
    buttons.forEach(btn => {
      const opt = btn.dataset.option;
      if (opt === pack.correct) btn.classList.add("correct");
    });

    if (ok) {
      streak += 1;
      stats.streakBest = Math.max(stats.streakBest, streak);
      markFeedback(true);
    } else {
      streak = 0;
      const wrongBtn = buttons.find(btn => btn.dataset.option === chosen);
      if (wrongBtn) wrongBtn.classList.add("wrong");
      markFeedback(false, `Answer: ${pack.correct}`);
    }

    markStat(current, ok);

    const instant = $("#chkInstantNext").checked;
    if (ok && instant) {
      setTimeout(() => {
        idx += 1; locked = false; nextQuestion();
      }, 650);
    } else {
      $("#btnNext").disabled = false;
    }
  }

  function renderTypingInputs() {
    const host = $("#typingInputs");
    host.innerHTML = "";
    const mode = session?.curMode;
    const useMulti = current && isMultiTypingActive(current, mode);
    const inputsNeeded = useMulti ? splitMeanings(current.meaning).length : 1;
    for (let i = 0; i < inputsNeeded; i += 1) {
      const input = document.createElement("input");
      input.className = "typingInput";
      input.autocomplete = "off";
      input.autocorrect = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;
      input.placeholder = inputsNeeded > 1 ? `Answer ${i + 1}` : "Type your answer…";
      host.appendChild(input);
    }
    host.querySelector("input")?.focus();
  }

  function checkTyping() {
    if (!session || locked) return;
    const mode = session.curMode;
    let ok = false;

    if (mode === "k2m") {
      if (current && isMultiTypingActive(current, mode)) {
        const expectedParts = splitMeanings(current.meaning).map(normalizeMeaning);
        const inputs = $$("#typingInputs input").map(input => normalizeMeaning(input.value));
        const uniqueInputs = new Set(inputs.filter(Boolean));
        ok = inputs.length === expectedParts.length
          && inputs.every(val => expectedParts.includes(val))
          && uniqueInputs.size === expectedParts.length;
      } else {
        const got = $$("#typingInputs input")[0]?.value || "";
        const normalized = normalizeMeaning(got);
        ok = splitMeanings(current.meaning).some(part => normalizeMeaning(part) === normalized);
      }
    } else {
      const got = $$("#typingInputs input")[0]?.value || "";
      ok = normalizeKanjiAnswer(got) === normalizeKanjiAnswer(current.kanji);
    }

    locked = true;
    if (ok) {
      streak += 1;
      stats.streakBest = Math.max(stats.streakBest, streak);
      markFeedback(true);
    } else {
      streak = 0;
      const expected = mode === "k2m" ? current.meaning : current.kanji;
      markFeedback(false, `Answer: ${expected}`);
    }
    markStat(current, ok);
    $("#btnNext").disabled = false;
  }

  $("#btnCheck").addEventListener("click", () => checkTyping());
  $("#btnNext").addEventListener("click", () => { if (!session) return; idx += 1; locked = false; nextQuestion(); });
  $("#btnStart").addEventListener("click", () => startSession());
  $("#btnPracticeStarred").addEventListener("click", () => { $("#chkStarOnly").checked = true; startSession(); });
  $("#btnStop").addEventListener("click", () => stopSession());
  $("#btnStar").addEventListener("click", () => current && toggleStar(current.id));
  $("#btnQuickStar").addEventListener("click", () => current && toggleStar(current.id));
  $("#chkAuto").addEventListener("change", () => { $("#numQ").disabled = $("#chkAuto").checked; });

  $("#btnLessonAll").addEventListener("click", () => setAllLessonsChecked(true));
  $("#btnLessonNone").addEventListener("click", () => setAllLessonsChecked(false));
  $("#selLevel").addEventListener("change", () => {
    settings.studyLevel = $("#selLevel").value;
    settings.studyLessons = null; // reset to all
    saveJSON(STORAGE.settings, settings);
    renderStudyLessons(true);
  });

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "`" || e.key === "~") {
      if (current) { e.preventDefault(); toggleStar(current.id); }
      return;
    }
    if (!session || !current) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (session.curAnswerType === "typing") {
        if (!locked) checkTyping(); else $("#btnNext").click();
      } else {
        if (locked) $("#btnNext").click();
      }
      return;
    }
    if (session.curAnswerType === "mc" && !locked) {
      if (["1","2","3","4"].includes(e.key)) {
        const i = parseInt(e.key, 10) - 1;
        const pack = session.mcPack;
        if (pack && i >= 0 && i < pack.options.length) { e.preventDefault(); checkMC(i, pack); }
      }
    }
  });

  // ---- View filters
  function renderViewLessonOptions() {
    const lvl = $("#viewLevel")?.value || settings.viewLevel || "all";
    const sel = $("#viewLesson");
    if (!sel) return;
    sel.innerHTML = "";
    const optAll = document.createElement("option");
    optAll.value = "all"; optAll.textContent = "All";
    sel.appendChild(optAll);

    if (!lessonIndex) return;

    if (lvl === "all") {
      lessonIndex.allPairs.forEach(p => {
        const o = document.createElement("option");
        o.value = `${p.lvl}|${p.sec}`;
        o.textContent = `${p.lvl} L${p.sec}`;
        sel.appendChild(o);
      });
    } else {
      (lessonIndex.byLevel[lvl] || []).forEach(sec => {
        const o = document.createElement("option");
        o.value = `${lvl}|${sec}`;
        o.textContent = `L${sec}`;
        sel.appendChild(o);
      });
    }

    sel.value = settings.viewLesson || "all";
  }

  function renderKanjiList() {
    const q = ($("#viewSearch").value || "").trim().toLowerCase();
    const starOnly = $("#viewStarOnly").checked;
    const lvl = $("#viewLevel")?.value || "all";
    const lesson = $("#viewLesson")?.value || "all";

    let list = items.slice();
    if (lvl !== "all") list = list.filter(x => (x.category||x.jlpt_level) === lvl);
    if (lesson !== "all") list = list.filter(x => `${(x.category||x.jlpt_level||"Unknown")}|${x.section}` === lesson);
    if (starOnly) list = list.filter(x => isStarred(x.id));
    if (q) {
      list = list.filter(x =>
        String(x.kanji).toLowerCase().includes(q) ||
        String(x.meaning).toLowerCase().includes(q) ||
        (x.readings || []).some(r => String(r).toLowerCase().includes(q))
      );
    }

    const host = $("#kanjiList");
    host.innerHTML = "";
    list.forEach(x => {
      const showMultiToggle = hasMultipleMeanings(x);
      const multiEnabled = showMultiToggle && !multiTypingOff.has(x.id);
      const row = document.createElement("div");
      row.className = "itemRow";
      row.innerHTML = `
        <div class="left">
          <div class="bigKanji">${escapeHtml(x.kanji)}</div>
          <div>
            <div class="meaning">${escapeHtml(x.meaning)}</div>
            <div class="tags">${escapeHtml(x.category||"")} • Lesson ${x.section}</div>
            ${showMultiToggle ? `
            <label class="mini multiToggle">
              <input type="checkbox" class="multiToggleInput" data-id="${escapeHtml(x.id)}" ${multiEnabled ? "checked" : ""} />
              Multi typing answers
            </label>` : ""}
          </div>
        </div>
        <button class="btn starBtn">${isStarred(x.id) ? "★" : "☆"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => toggleStar(x.id));
      const toggle = row.querySelector(".multiToggleInput");
      if (toggle) {
        toggle.addEventListener("change", (e) => {
          const id = e.target.dataset.id;
          if (!id) return;
          if (e.target.checked) multiTypingOff.delete(id);
          else multiTypingOff.add(id);
          saveJSON(STORAGE.multiTypingOff, Array.from(multiTypingOff));
        });
      }
      host.appendChild(row);
    });
    if (!list.length) host.innerHTML = `<div class="hint"><p class="small muted">No results.</p></div>`;
  }

  $("#viewSearch").addEventListener("input", () => renderKanjiList());
  $("#viewStarOnly").addEventListener("change", () => renderKanjiList());
  $("#viewLevel").addEventListener("change", (e) => {
    settings.viewLevel = e.target.value;
    settings.viewLesson = "all";
    saveJSON(STORAGE.settings, settings);
    renderViewLessonOptions();
    renderKanjiList();
  });
  $("#viewLesson").addEventListener("change", (e) => {
    settings.viewLesson = e.target.value;
    saveJSON(STORAGE.settings, settings);
    renderKanjiList();
  });

  // ---- Stars import/export
  $("#btnExportStars").addEventListener("click", () => {
    const payload = { version:1, stars: Array.from(starred) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "JLPT_Combo_Kanji_stars.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  $("#fileImportStars").addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      if (Array.isArray(payload.stars)) {
        starred = new Set(payload.stars);
        saveJSON(STORAGE.stars, Array.from(starred));
        renderKanjiList(); renderStarsUI();
        alert("Stars imported ✅");
      } else alert("Invalid stars file.");
    } catch { alert("Import failed."); }
    e.target.value = "";
  });

  function pct(c,t){ return t ? Math.round((c/t)*100) : 0; }

  function renderStats() {
    const top = $("#statsTop"); top.innerHTML = "";
    const cards = [
      {k:"Total", v: stats.total},
      {k:"Correct", v: stats.correct},
      {k:"Wrong", v: stats.wrong},
      {k:"Accuracy", v: `${pct(stats.correct, stats.total)}%`},
      {k:"Best streak", v: stats.streakBest},
      {k:"Starred", v: starred.size}
    ];
    cards.forEach(c => {
      const div = document.createElement("div");
      div.className = "field";
      div.innerHTML = `<span>${escapeHtml(c.k)}</span><div style="font-size:20px;font-weight:900">${escapeHtml(c.v)}</div>`;
      top.appendChild(div);
    });

    const hard = Object.entries(stats.byId).map(([id, s]) => {
      const t = s.c + s.w;
      const miss = t ? (s.w / t) : 0;
      const it = items.find(x => x.id === id);
      return { id, miss, t, kanji: it?.kanji || id, meaning: it?.meaning || "" };
    }).filter(x => x.t >= 3).sort((a,b) => b.miss - a.miss).slice(0, 10);

    const hardHost = $("#hardList"); hardHost.innerHTML = "";
    if (!hard.length) hardHost.innerHTML = `<div class="hint"><p class="small muted">Answer a few questions first (3+ per word) and this will populate.</p></div>`;
    else hard.forEach(x => {
      const row = document.createElement("div");
      row.className = "itemRow";
      row.innerHTML = `
        <div class="left">
          <div class="bigKanji">${escapeHtml(x.kanji)}</div>
          <div>
            <div class="meaning">${escapeHtml(x.meaning)}</div>
            <div class="tags">Miss rate: ${Math.round(x.miss*100)}% • Attempts: ${x.t}</div>
          </div>
        </div>
        <button class="btn starBtn">${isStarred(x.id) ? "★" : "☆"}</button>
      `;
      row.querySelector("button").addEventListener("click", () => toggleStar(x.id));
      hardHost.appendChild(row);
    });

    const secHost = $("#sectionStats"); secHost.innerHTML = "";
    const secs = Object.entries(stats.byLesson)
      .map(([k, s]) => ({ k, s, lvl: k.split("-")[0], sec: parseInt(k.split("-")[1]||"0",10) }))
      .sort((a,b) => (a.lvl.localeCompare(b.lvl) || a.sec - b.sec));

    if (!secs.length) secHost.innerHTML = `<div class="hint"><p class="small muted">No lesson stats yet.</p></div>`;
    else secs.forEach(({lvl, sec, s}) => {
      const t = s.c + s.w;
      const row = document.createElement("div");
      row.className = "itemRow";
      row.innerHTML = `<div class="left"><div class="meaning">${escapeHtml(lvl)} • Lesson ${escapeHtml(sec)}</div><div class="tags">Accuracy: ${pct(s.c,t)}% • Attempts: ${t}</div></div>`;
      secHost.appendChild(row);
    });
  }

  $("#btnResetStats").addEventListener("click", () => {
    if (!confirm("Reset stats?")) return;
    stats = { total:0, correct:0, wrong:0, streakBest:0, byId:{}, byLesson:{} };
    saveJSON(STORAGE.stats, stats);
    renderStats();
    alert("Stats reset ✅");
  });

  function renderSettings() {
    $("#selReadings").value = settings.showReadings || "off";
    $("#selMcCount").value = String(settings.mcCount || 4);
    $("#selMultiTyping").value = settings.multiTyping || "on";
  }
  $("#selReadings").addEventListener("change", (e) => { settings.showReadings = e.target.value; saveJSON(STORAGE.settings, settings); });
  $("#selMcCount").addEventListener("change", (e) => { settings.mcCount = parseInt(e.target.value,10); saveJSON(STORAGE.settings, settings); });
  $("#selMultiTyping").addEventListener("change", (e) => { settings.multiTyping = e.target.value; saveJSON(STORAGE.settings, settings); });

  $("#btnExportData").addEventListener("click", () => {
    const payload = { version:1, items };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "JLPT_Combo_Kanji_data.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  $("#fileImportData").addEventListener("change", async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      if (Array.isArray(payload.items) && payload.items.length) {
        saveJSON(STORAGE.data, payload);
        alert("Data imported ✅ Reloading…");
        location.reload();
      } else alert("Invalid data file.");
    } catch { alert("Import failed."); }
    e.target.value = "";
  });

  $("#btnResetAll").addEventListener("click", () => {
    if (!confirm("Reset EVERYTHING? (data override, stars, stats, settings)")) return;
    Object.values(STORAGE).forEach(k => localStorage.removeItem(k));
    location.reload();
  });

  async function init() {
    DATA = await loadData();
    items = DATA.items || [];
    buildLessonIndex();

    // Restore filter selections
    $("#selLevel").value = settings.studyLevel || "all";
    $("#viewLevel").value = settings.viewLevel || "all";

    renderStudyLessons(false);
    renderViewLessonOptions();

    $("#chkAuto").dispatchEvent(new Event("change"));
    setTab("study");

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(()=>{}));
    }
  }
  init();
})();
