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
