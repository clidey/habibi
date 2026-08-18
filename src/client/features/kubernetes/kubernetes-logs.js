import { categorizeError } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

export function createKubernetesLogs({ find, getContext, showDetail }) {
  let logFollowTimer = null;
  let logLines = [];
  function stop() {
    if (!logFollowTimer) return;
    clearInterval(logFollowTimer);
    logFollowTimer = null;
  }

  function renderLogOutput({ stickToBottom = false } = {}) {
    const output = find('#kubernetes-log-output');
    const filter = find('#kubernetes-log-filter');
    const lineCount = find('#kubernetes-log-count');
    if (!output) return;
    const query = String(filter?.value || '')
      .trim()
      .toLowerCase();
    const visibleLines = query
      ? logLines.filter((line) => line.toLowerCase().includes(query))
      : logLines;
    setHtml(
      output,
      escapeHtml(
        visibleLines.join('\n') || (query ? 'No matching log lines.' : 'No log lines returned.'),
      ),
    );
    if (lineCount)
      lineCount.textContent = query
        ? `${visibleLines.length}/${logLines.length} lines`
        : `${logLines.length} lines`;
    if (stickToBottom && !query) output.scrollTop = output.scrollHeight;
  }

  async function showLogs(pod, namespace) {
    stop();
    logLines = [];
    const output = find('#kubernetes-output');
    if (!output) return;
    const read = async () => {
      const response = await fetch('/api/kubernetes/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pod, namespace, context: getContext() }),
      });
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'Could not read pod logs.');
      logLines = String(result.output || '')
        .split('\n')
        .filter((line, index, lines) => line || index < lines.length - 1);
      renderLogOutput({ stickToBottom: true });
      return result;
    };
    setHtml(
      output,
      `<div class="kubernetes-log-page"><header><button type="button" class="kubernetes-detail-back" id="kubernetes-logs-back">${icon('arrow-left')} Resource details</button><span><small>Pod logs</small><b>${escapeHtml(pod)}</b><em>${escapeHtml(namespace)}</em></span><button type="button" class="kubernetes-log-button" id="kubernetes-follow-logs">${icon('radio')} Follow</button></header><div class="kubernetes-log-filter-row"><span>${icon('search')}</span><input id="kubernetes-log-filter" type="search" autocomplete="off" placeholder="Filter these log lines…" aria-label="Filter pod logs" /><small id="kubernetes-log-count">Loading…</small></div><pre id="kubernetes-log-output" class="kubernetes-log-output"><span class="spinner"></span> Reading logs…</pre></div>`,
    );
    find('#kubernetes-logs-back').onclick = () => showDetail('pods', pod, namespace);
    find('#kubernetes-log-filter').oninput = () => renderLogOutput();
    const follow = find('#kubernetes-follow-logs');
    follow.onclick = () => {
      if (logFollowTimer) {
        stop();
        follow.innerHTML = `${icon('radio')} Follow`;
        refreshIcons();
        return;
      }
      follow.innerHTML = `${icon('pause')} Pause`;
      logFollowTimer = setInterval(() => read().catch(stop), 3000);
      refreshIcons();
    };
    try {
      await read();
    } catch (error) {
      setHtml(
        find('#kubernetes-log-output'),
        escapeHtml(categorizeError(error, 'Could not read pod logs.')),
      );
    }
    refreshIcons();
  }

  return { show: showLogs, stop };
}
