import { renderFailure } from '../../core/failure-view.js';
import { setHtml } from '../../core/safe-dom.js';
import { approvalNotice, escapeHtml, icon, refreshIcons } from '../../core/view-helpers.js';

/** Owns imported skill discovery, review, write confirmation, and launch. */
export function createSkillsFeature({ input, defaultView, resultsView, count, notify, requestApproval, onHome, onOpen }) {
function showSkills() {
  onOpen('skills'); defaultView.classList.add('hidden'); resultsView.classList.remove('hidden'); count.textContent='Loading skills…';
  const skills = [['⌁','files','Files','Native index · Metadata read'],['□','calendar','Calendar','EventKit · Read & write'],['M','gmail','Mail','Gmail + Zoho IMAP · Local accounts'],['◔','whatsapp','WhatsApp','OpenWA · Localhost only'],['◉','files','Browser','Extension · Tabs & history'],['✣','agents','Agent Dock','Local Codex & Claude processes']];
  const render = imported => {
    const groups = { codex:[], claude:[], mcp:[] };
    imported.forEach(skill => groups[skill.source]?.push(skill));
    const importedMarkup = [['codex','Codex skills'],['claude','Claude Code skills'],['mcp','MCP servers']].map(([source, label]) => groups[source].length ? `<section class="imported-skill-group"><span class="briefing-heading">${label}</span><div class="imported-skill-list">${groups[source].map(skill => `<button class="imported-skill" data-imported-skill="${escapeHtml(skill.id)}"><span class="icon agents">${icon(source === 'mcp' ? 'plug-zap' : source === 'codex' ? 'braces' : 'sparkles')}</span><span><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description)}</small></span><em>${skill.kind === 'mcp-server' ? 'MCP' : 'IMPORTED'}</em><i>${icon('chevron-right')}</i></button>`).join('')}</div></section>` : '').join('');
    count.textContent = `${skills.length + imported.length} skills available`;
    resultsView.innerHTML=`<div class="result-header conversation-mode"><button class="back-button" id="back-skills">${icon('arrow-left')} Habibi</button><span class="verified">● local capabilities</span></div><div class="skill-grid">${skills.map(s=>`<article class="skill"><span class="icon ${s[1]}">${s[0]}</span><h3>${s[2]}</h3><p>${s[3]}</p><div class="skill-footer"><span class="permission">● enabled</span><span>Built in</span></div></article>`).join('')}</div><div class="imported-skills"><div class="imported-skills-heading"><span class="briefing-heading">IMPORTED AGENT CAPABILITIES</span><small>Read from local Codex, Claude, and MCP configuration. Nothing runs until you approve it.</small></div>${importedMarkup || '<div class="clear-day imported-empty"><span class="icon agents">' + icon('scan-search') + '</span><span><b>No imported skills found yet.</b><small>Add a Codex SKILL.md, Claude command, or local MCP configuration and reopen Skills.</small></span></div>'}</div>`;
    document.querySelector('#back-skills').onclick = onHome;
    resultsView.querySelectorAll('[data-imported-skill]').forEach(button => button.onclick = () => showImportedSkill(button.dataset.importedSkill));
    refreshIcons();
  };
  fetch('/api/agent-skills').then(response => response.json()).then(data => render(data.ok ? data.skills || [] : [])).catch(() => render([]));
}
function showImportedSkill(id) {
  onOpen('imported-skill'); count.textContent = 'Inspecting imported skill…';
  setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-imported-skills">${icon('arrow-left')} Skills</button><span class="verified">● review before run</span></div><div class="loading-state"><span class="spinner"></span> Inspecting this local capability…</div>`);
  document.querySelector('#back-imported-skills').onclick = showSkills;
  fetch('/api/agent-skills/preview', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id }) }).then(response => response.json()).then(data => {
    if (!data.ok) throw new Error(data.error || 'Could not inspect this skill.');
    const skill = data.skill;
    const run = async ({ toolName, toolInput }) => {
      const approvalToken = await requestApproval('agent-skill.execute', { id, toolName:toolName ?? null, toolInput:toolInput ?? null });
      const button = document.querySelector('#run-imported-skill'); if (button) { button.disabled = true; setHtml(button, '<span class="mini-spinner"></span> Starting…'); }
      const result = await fetch('/api/agent-skills/execute', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ id, toolName, toolInput, approvalToken }) }).then(response => response.json());
      if (!result.ok) { if (button) { button.disabled=false; button.textContent='Try again'; } return notify(result.error || 'Could not run that skill.'); }
      if (result.result) { const output = document.querySelector('#imported-skill-output'); setHtml(output, `<pre>${escapeHtml(JSON.stringify(result.result, null, 2).slice(0, 12_000))}</pre>`); notify('MCP tool completed'); }
      else { notify(`${skill.source === 'codex' ? 'Codex' : 'Claude Code'} opened with your approved request`); onHome(); }
    };
    if (skill.kind === 'mcp-server') {
      const tools = data.tools || [];
      // A write-capable tool gets a real second confirmation, reusing the
      // exact system-action-confirm pattern (arrow-key nav, esc-to-cancel,
      // dangerous-action styling come for free via handleConfirmationKeyboard)
      // rather than treating "select a tool, click Run" as the whole
      // approval flow the way a read-only tool can.
      const renderMcpReview = (selectedTool = tools[0]?.name || '', pendingInput) => {
        setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-imported-skills">${icon('arrow-left')} Skills</button><span class="verified">● MCP · reviewed</span></div><section class="provider-setup imported-skill-review"><div class="chat-title"><span class="icon agents">${icon('plug-zap')}</span><span><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description)}</small></span></div><p class="imported-note">${escapeHtml(data.action)}. Connecting only happens after you opened this review.</p><label>Tool<select id="imported-mcp-tool">${tools.map(tool => `<option value="${escapeHtml(tool.name)}" ${tool.name === selectedTool ? 'selected' : ''}>${escapeHtml(tool.name)}${tool.readOnly ? ' · read' : ' · writes'}</option>`).join('')}</select></label><label>JSON input<textarea id="imported-mcp-input" rows="5" spellcheck="false">${escapeHtml(pendingInput ?? '{}')}</textarea></label><div class="provider-actions"><span>${approvalNotice('Running this tool')}</span><button class="primary" id="run-imported-skill">Run tool <kbd>↵</kbd></button></div><div id="imported-skill-output" class="imported-skill-output"></div></section>`);
        document.querySelector('#back-imported-skills').onclick = showSkills;
        document.querySelector('#run-imported-skill').onclick = () => {
          const toolName = document.querySelector('#imported-mcp-tool').value;
          const rawInput = document.querySelector('#imported-mcp-input').value;
          let toolInput;
          try { toolInput = JSON.parse(rawInput); } catch (_) { return notify('Tool input must be valid JSON.'); }
          const tool = tools.find(candidate => candidate.name === toolName);
          if (tool && tool.readOnly === false) return renderMcpWriteConfirm(tool, toolInput, rawInput);
          run({ toolName, toolInput });
        };
        refreshIcons();
      };
      const renderMcpWriteConfirm = (tool, toolInput, rawInput) => {
        setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-mcp-confirm">${icon('arrow-left')} ${escapeHtml(skill.name)}</button><span class="verified">● review before run</span></div><section class="system-action-confirm is-dangerous" data-confirm-choice="confirm"><div class="system-action-hero"><span class="system-action-icon">${icon('plug-zap')}</span><span><span class="compose-label">MCP TOOL · WRITES</span><h2>Run “${escapeHtml(tool.name)}”?</h2><p>This tool can make changes, not just read data.</p></span></div><div class="system-action-note">${icon('shield-check')}<span>${escapeHtml(skill.name)} runs locally; nothing is sent until you confirm.</span></div><div class="confirmation-options" role="group" aria-label="Confirm running ${escapeHtml(tool.name)}"><button type="button" class="confirmation-choice confirm-option selected" id="confirm-mcp-tool" data-choice="confirm"><span><b>Run ${escapeHtml(tool.name)}</b><small>Requires your confirmation</small></span><kbd>↵</kbd></button><button type="button" class="confirmation-choice confirm-option" id="cancel-mcp-tool" data-choice="cancel"><span><b>Keep reviewing</b><small>Return without running</small></span><kbd>esc</kbd></button></div><small class="confirmation-hint"><kbd>← →</kbd> choose &nbsp; <kbd>↵</kbd> continue &nbsp; <kbd>esc</kbd> go back</small></section>`);
        const back = () => renderMcpReview(tool.name, rawInput);
        document.querySelector('#back-mcp-confirm').onclick = back;
        document.querySelector('#cancel-mcp-tool').onclick = back;
        resultsView.querySelectorAll('.confirmation-choice').forEach(button => button.onclick = () => { document.querySelector('.system-action-confirm').dataset.confirmChoice = button.dataset.choice; resultsView.querySelectorAll('.confirmation-choice').forEach(choice => choice.classList.toggle('selected', choice === button)); if (button.dataset.choice === 'cancel') back(); });
        document.querySelector('#confirm-mcp-tool').onclick = () => { renderMcpReview(tool.name, rawInput); run({ toolName:tool.name, toolInput }); };
        refreshIcons();
      };
      renderMcpReview();
    } else {
      setHtml(resultsView, `<div class="result-header conversation-mode"><button class="back-button" id="back-imported-skills">${icon('arrow-left')} Skills</button><span class="verified">● imported locally</span></div><section class="provider-setup imported-skill-review"><div class="chat-title"><span class="icon agents">${icon(skill.source === 'codex' ? 'braces' : 'sparkles')}</span><span><b>${escapeHtml(skill.name)}</b><small>${escapeHtml(skill.description)}</small></span></div><p class="imported-note">${escapeHtml(data.action)}. ${approvalNotice('Launching the external agent')}</p><details class="instruction-preview"><summary>Review imported instruction</summary><pre>${escapeHtml(data.prompt || '')}</pre></details><label>Your request<textarea id="imported-skill-request" rows="3" placeholder="Optional context for this run…"></textarea></label><div class="provider-actions"><span>Recorded locally without prompt contents.</span><button class="primary" id="run-imported-skill">Open in ${skill.source === 'codex' ? 'Codex' : 'Claude'} <kbd>↵</kbd></button></div></section>`);
      document.querySelector('#back-imported-skills').onclick = showSkills;
      document.querySelector('#run-imported-skill').onclick = () => run({ toolInput:document.querySelector('#imported-skill-request').value });
    }
    refreshIcons();
  }).catch(error => { renderFailure(resultsView, error, { fallback:'Could not inspect this skill.', retry:() => showImportedSkill(id) }); });
}

  return { show:showSkills, showImported:showImportedSkill };
}
