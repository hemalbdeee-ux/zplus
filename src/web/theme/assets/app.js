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
  var WIDTH = 1280;
  var LINK = /^(?:https?:\/\/)?(?:(?:web|wayback)\.)?archive\.org\/web\/([0-9*]*)(?:[a-z]{2}_)?\/(.+)$/i;
  var DATE = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2})(?:[T ](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?)?)?Z?$/i;
  var timer = null;

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
  function cellOf(ts) { return table ? table.querySelector('td[data-month="' + ts.slice(0, 6) + '"]') : null; }

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
    var verdict = cell ? ['good', 'weak', 'bad'].filter(function (c) { return cell.classList.contains(c); })[0] || 'none' : 'none';
    pill.className = 'pill ' + verdict;
    pill.textContent = verdict;
    note.textContent = cell ? cell.getAttribute('title') : 'no homepage capture checked';
    if (table) {
      var picked = table.querySelectorAll('td.pick');
      for (var i = 0; i < picked.length; i++) picked[i].classList.remove('pick');
      if (cell) cell.classList.add('pick');
    }
  }

  function bare(host) { return host.toLowerCase().replace(/\.$/, '').replace(/^www\d{0,3}\./, ''); }
  function stamp(digits) {
    var t = (digits + '00000000000000').slice(0, 14);
    if (t.slice(4, 6) === '00') t = t.slice(0, 4) + '01' + t.slice(6);
    if (t.slice(6, 8) === '00') t = t.slice(0, 6) + '01' + t.slice(8);
    return t;
  }

  // The same rules as the server (src/web/snapshot.ts); the server has the last word.
  function parse(input) {
    var s = input.trim();
    if (!s) return null;
    var m = LINK.exec(s);
    if (m) {
      if (!/^\d{4,14}$/.test(m[1])) return { error: 'That link opens the calendar of all captures. Open one capture in it and copy the link from the address bar.' };
      var page;
      try { page = new URL(/^https?:\//i.test(m[2]) ? m[2].replace(/^(https?:)\/+/i, '$1//') : 'http://' + m[2]); } catch (e) { page = null; }
      if (!page || (page.protocol !== 'http:' && page.protocol !== 'https:')) return { error: 'That Wayback Machine link has no page address after the date.' };
      if (bare(page.hostname) !== domain) return { error: 'That link is a capture of ' + bare(page.hostname) + ', not of ' + domain + '.' };
      page.hash = '';
      return { ts: stamp(m[1]), url: page.href };
    }
    var d = DATE.exec(s);
    var digits = /^\d{4,14}$/.test(s) ? s : '';
    if (!digits && d) {
      digits = '';
      for (var i = 1; i < d.length && d[i] !== undefined; i++) digits += (d[i].length < 2 ? '0' : '') + d[i];
    }
    if (!digits) return { error: 'Type a date like 2015-06-12, or paste the link of a capture from web.archive.org.' };
    var ts = stamp(digits);
    if (Number(ts.slice(4, 6)) > 12 || Number(ts.slice(6, 8)) > 31) return { error: 'Type a date like 2015-06-12, or paste the link of a capture from web.archive.org.' };
    return { ts: ts };
  }

  function say(text, bad) {
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = !text;
    hint.classList.toggle('bad', !!bad);
  }

  function listed(ts) {
    if (!select) return false;
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === ts) return true;
    return false;
  }

  function fromList() {
    if (select) show(select.value);
  }

  function fromCustom() {
    var own = parse(custom.value);
    if (!own) { say(''); fromList(); return; }
    if (own.error) { say(own.error, true); return; }
    say(select ? 'Your snapshot is used instead of the list.' : '');
    show(own.ts, own.url);
  }

  if (select) select.addEventListener('change', function () { if (custom) custom.value = ''; say(''); fromList(); });
  if (custom) custom.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(fromCustom, 400); });
  if (custom && custom.value.trim()) {
    var own = parse(custom.value);
    if (own && own.error) say(own.error, true);
    else if (own && select) say('Your snapshot is used instead of the list.');
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
      say(select ? 'This month is not in the list, so it is filled in as your own snapshot.' : '');
      show(ts);
    }
  }

  if (table && custom) {
    table.classList.add('tl-pick');
    var cells = table.querySelectorAll('td[data-ts]');
    for (var i = 0; i < cells.length; i++) {
      cells[i].tabIndex = 0;
      cells[i].setAttribute('role', 'button');
    }
    table.addEventListener('click', function (e) {
      var cell = e.target.closest && e.target.closest('td[data-ts]');
      if (cell) pick(cell);
    });
    table.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var cell = e.target.closest && e.target.closest('td[data-ts]');
      if (!cell) return;
      e.preventDefault();
      pick(cell);
    });
  }
})();
