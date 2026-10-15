// Job pages: poll the job until it finishes, then reload to show the result.
(function () {
  var box = document.querySelector('[data-job]');
  if (!box) return;
  var id = box.getAttribute('data-job');
  var status = box.getAttribute('data-status');
  if (status !== 'queued' && status !== 'running') return;

  function set(field, text) {
    var el = box.querySelector('[data-field="' + field + '"]');
    if (el) el.textContent = text;
  }

  function poll() {
    fetch('/api/jobs/' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (job) {
        if (!job) return setTimeout(poll, 5000);
        if (job.status !== status && (job.status === 'done' || job.status === 'failed')) {
          location.reload();
          return;
        }
        status = job.status;
        set('position', job.position ? 'Waiting in line, position ' + job.position + '.' : '');
        if (job.message) set('message', job.message);
        if (job.kind === 'restore') set('counts', (job.done || 0).toLocaleString('en-US') + ' URLs done, ' + (job.queued || 0).toLocaleString('en-US') + ' waiting');
        setTimeout(poll, 2000);
      })
      .catch(function () { setTimeout(poll, 5000); });
  }
  setTimeout(poll, 1500);
})();

// Snapshots page: a preview of the chosen capture, months in the timeline that pick their capture,
// and a snapshot the user names (a Wayback Machine link or a date). The form works without this.
(function () {
  document.documentElement.classList.add('js');
  var panel = document.querySelector('[data-preview]');
  if (!panel) return;
  var archive = panel.getAttribute('data-archive');
  var domain = panel.getAttribute('data-domain');
  var refusals = null;
  try { refusals = JSON.parse((document.getElementById('refusals') || {}).textContent || 'null'); } catch (e) { refusals = null; }
  var home = 'http://' + panel.getAttribute('data-host') + '/';
  var box = panel.querySelector('.preview-frame');
  var frame = box.querySelector('iframe');
  var wait = box.querySelector('.preview-wait');
  var open = panel.querySelector('[data-open]');
  var label = panel.querySelector('[data-label]');
  var pill = panel.querySelector('[data-verdict]');
  var note = panel.querySelector('[data-note]');
  var select = document.getElementById('target');
  var custom = document.getElementById('custom');
  var hint = document.getElementById('custom-hint');
  var table = document.querySelector('table.tl');
  var MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  var WIDTH = 1280;
  var LINK = /^(?:https?:\/\/)?(?:(?:web|wayback)\.)?archive\.org\/web\/([0-9*]*)(?:[a-z]{2}_)?\/(.+)$/i;
  var DATE = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2})(?:[T ](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?)?)?Z?$/i;
  var timer = null;
  var buttons = [];

  // Laid out like a desktop screen, then scaled to the panel.
  function fit() {
    if (box.clientWidth) box.style.setProperty('--s', String(box.clientWidth / WIDTH));
  }
  box.classList.add('scaled');
  fit();
  if (window.ResizeObserver) new ResizeObserver(fit).observe(box);
  else window.addEventListener('resize', fit);

  function loaded() { wait.hidden = true; }
  frame.addEventListener('load', loaded);
  var slow = setTimeout(loaded, 15000);

  function day(ts) { return ts.slice(0, 4) + '-' + ts.slice(4, 6) + '-' + ts.slice(6, 8); }
  function monthName(month) { return MONTHS[Number(month.slice(4, 6)) - 1] + ' ' + month.slice(0, 4); }
  function cellOf(ts) { return table ? table.querySelector('td[data-month="' + ts.slice(0, 6) + '"]') : null; }
  function verdictOf(cell) {
    return cell ? ['good', 'weak', 'bad'].filter(function (c) { return cell.classList.contains(c); })[0] || 'none' : 'none';
  }

  function show(ts, url) {
    var src = archive + '/web/' + ts + 'if_/' + (url || home);
    if (frame.getAttribute('src') !== src) {
      wait.hidden = false;
      clearTimeout(slow);
      slow = setTimeout(loaded, 15000);
      frame.setAttribute('src', src);
    }
    open.href = archive + '/web/' + ts + '/' + (url || home);
    label.textContent = day(ts);
    frame.title = 'Capture of ' + domain + ' from ' + day(ts);
    var cell = cellOf(ts);
    var verdict = verdictOf(cell);
    pill.className = 'pill ' + verdict;
    pill.textContent = verdict;
    note.textContent = cell ? cell.getAttribute('title') : monthName(ts.slice(0, 6)) + ': no homepage capture checked';
    mark(cell);
  }

  function bare(host) { return host.toLowerCase().replace(/\.$/, '').replace(/^www\d{0,3}\./, ''); }

  // A Wayback timestamp from 4 to 14 digits, padded and checked as the server does (parseTimestamp).
  function stamp(digits) {
    var t = (digits + '00000000000000').slice(0, 14);
    if (t.slice(4, 6) === '00') t = t.slice(0, 4) + '01' + t.slice(6);
    if (t.slice(6, 8) === '00') t = t.slice(0, 6) + '01' + t.slice(8);
    var y = Number(t.slice(0, 4)), mo = Number(t.slice(4, 6)), d = Number(t.slice(6, 8));
    var days = mo >= 1 && mo <= 12 ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 0;
    if (!days || d > days || Number(t.slice(8, 10)) > 23 || Number(t.slice(10, 12)) > 59 || Number(t.slice(12, 14)) > 59) return null;
    return t;
  }

  // The same rules as the server (src/web/snapshot.ts); the server has the last word.
  function parse(input) {
    var s = input.trim();
    if (!s) return null;
    if (s.length > 2000) return { error: 'That link is too long.' };
    var m = LINK.exec(s);
    var ts, url;
    if (m) {
      if (!/^\d{4,14}$/.test(m[1])) return { error: 'That link opens the calendar of all captures. Open one capture in it and copy the link from the address bar.' };
      var page;
      try { page = new URL(/^https?:\//i.test(m[2]) ? m[2].replace(/^(https?:)\/+/i, '$1//') : 'http://' + m[2]); } catch (e) { page = null; }
      if (!page || (page.protocol !== 'http:' && page.protocol !== 'https:')) return { error: 'That Wayback Machine link has no page address after the date.' };
      if (bare(page.hostname) !== domain) return { error: 'That link is a capture of ' + bare(page.hostname) + ', not of ' + domain + '.' };
      ts = stamp(m[1]);
      if (!ts) return { error: 'The date in that Wayback Machine link is not valid.' };
      page.hash = '';
      url = page.href;
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^www\./i.test(s) || /\.[a-z]{2,}(\/|$)/i.test(s)) {
        return { error: 'Paste the link of one capture from web.archive.org, like https://web.archive.org/web/20150612000000/http://' + domain + '/' };
      }
      var d = DATE.exec(s);
      var digits = /^\d{4,14}$/.test(s) ? s : '';
      if (!digits && d) {
        for (var i = 1; i < d.length && d[i] !== undefined; i++) digits += (d[i].length < 2 ? '0' : '') + d[i];
      }
      ts = digits ? stamp(digits) : null;
      if (!ts) return { error: 'Type a date like 2015-06-12, or paste the link of a capture from web.archive.org.' };
    }
    if (ts < '19960101000000') return { error: 'The Wayback Machine has no captures before 1996.' };
    if (ts > new Date().toISOString().replace(/\D/g, '').slice(0, 14)) return { error: day(ts) + ' is in the future.' };
    return { ts: ts, url: url };
  }

  // What the server will say about a date: it sends its answer for every month (src/web/snapshot.ts).
  function refusal(ts) {
    if (!refusals) return '';
    var month = ts.slice(0, 6);
    var at = month < refusals.first ? refusals.before : refusals.months[month];
    return at === undefined || at === null ? '' : refusals.messages[at].split('{date}').join(day(ts));
  }

  function say(text, bad) {
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = !text;
    hint.classList.toggle('bad', !!bad);
    hint.removeAttribute('data-refused');
    hint.removeAttribute('role');
    hint.setAttribute('aria-live', 'polite');
    if (custom) {
      if (bad) custom.setAttribute('aria-invalid', 'true');
      else custom.removeAttribute('aria-invalid');
    }
  }

  function listed(ts) {
    if (!select) return false;
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === ts) return true;
    return false;
  }

  function fromList() {
    if (select) show(select.value);
  }

  // Tells what will happen with the snapshot in the field, and shows it.
  function fromCustom() {
    var own = parse(custom.value);
    if (!own) { say(''); fromList(); return; }
    if (own.error) { say(own.error, true); return; }
    var problem = refusal(own.ts);
    say(problem || (select ? 'Your snapshot is used instead of the list.' : ''), !!problem);
    show(own.ts, own.url);
  }

  if (select) select.addEventListener('change', function () { if (custom) custom.value = ''; say(''); fromList(); });
  if (custom) custom.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(fromCustom, 400); });
  // A value the server refused keeps its message until it is edited; the preview shows the server's choice.
  if (custom && custom.value.trim() && !(hint && hint.hasAttribute('data-refused'))) fromCustom();

  // Months with a capture become buttons; one of them is in the tab order and arrows move between them.
  function mark(cell) {
    if (!table) return;
    var picked = table.querySelectorAll('td.pick');
    for (var i = 0; i < picked.length; i++) picked[i].classList.remove('pick');
    if (cell) cell.classList.add('pick');
    var current = cell ? cell.querySelector('.tl-btn') : null;
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].setAttribute('aria-pressed', buttons[j] === current ? 'true' : 'false');
    }
    if (current) rove(current);
  }
  function rove(button) {
    for (var i = 0; i < buttons.length; i++) buttons[i].tabIndex = buttons[i] === button ? 0 : -1;
  }

  function pick(cell) {
    var ts = cell.getAttribute('data-ts');
    if (listed(ts)) {
      select.value = ts;
      custom.value = '';
      say('');
      show(ts);
    } else {
      custom.value = day(ts) + ' ' + ts.slice(8, 10) + ':' + ts.slice(10, 12) + ':' + ts.slice(12, 14);
      var problem = refusal(ts);
      say(problem || (select ? 'This month is not in the list, so it is filled in as your own snapshot.' : ''), !!problem);
      show(ts);
    }
  }

  function step(button, key) {
    var i = buttons.indexOf(button);
    if (key === 'ArrowLeft') return buttons[i - 1];
    if (key === 'ArrowRight') return buttons[i + 1];
    if (key === 'Home') return buttons[0];
    if (key === 'End') return buttons[buttons.length - 1];
    // Up and down: the nearest month with a capture in the year above or below.
    var td = button.parentNode;
    var row = td.parentNode;
    var col = Array.prototype.indexOf.call(row.children, td);
    var other = key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    while (other) {
      var best = null;
      for (var c = 0; c < other.children.length; c++) {
        var b = other.children[c].querySelector && other.children[c].querySelector('.tl-btn');
        if (b && (!best || Math.abs(c - col) < Math.abs(best.c - col))) best = { b: b, c: c };
      }
      if (best) return best.b;
      other = key === 'ArrowUp' ? other.previousElementSibling : other.nextElementSibling;
    }
    return null;
  }

  if (table && custom) {
    var cells = table.querySelectorAll('td[data-ts]');
    for (var i = 0; i < cells.length; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tl-btn';
      b.tabIndex = -1;
      b.setAttribute('aria-pressed', 'false');
      var sr = cells[i].querySelector('.sr');
      if (sr) b.appendChild(sr);
      cells[i].appendChild(b);
      buttons.push(b);
    }
    if (buttons.length) {
      // A chosen month without a capture keeps its outline; the first month then holds the tab stop.
      var chosen = table.querySelector('td.pick .tl-btn');
      if (chosen) mark(chosen.parentNode);
      else rove(buttons[0]);
      var tip = document.querySelector('[data-tl-tip]');
      if (tip) tip.hidden = false;
    }
    table.addEventListener('click', function (e) {
      var button = e.target.closest && e.target.closest('.tl-btn');
      if (button) pick(button.parentNode);
    });
    table.addEventListener('keydown', function (e) {
      var button = e.target.closest && e.target.closest('.tl-btn');
      if (!button || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(e.key) < 0) return;
      var next = step(button, e.key);
      e.preventDefault();
      if (next) {
        rove(next);
        next.focus();
      }
    });
  }
})();
