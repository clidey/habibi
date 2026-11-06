import React, { useState } from 'react';
import {
  Badge,
  Button,
  CatalogIcon,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@clidey/ux';
import { workflows } from './file-workflow-data.js';
import { WorkflowConfirmation } from './workflow-confirmation.jsx';
import './interactive.css';

export function FileWorkflowDemo() {
  const [task, setTask] = useState('rename');
  const [phase, setPhase] = useState('draft');
  const [selected, setSelected] = useState([0, 1, 2]);
  const [contents, setContents] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const [previewed, setPreviewed] = useState([]);
  const [applied, setApplied] = useState([]);
  const [confirmation, setConfirmation] = useState('');
  const [notice, setNotice] = useState('Choose a task, then prepare a proposal. Nothing has run.');
  const workflow = workflows[task];
  function reset(next = task) {
    setTask(next);
    setPhase('draft');
    setSelected(workflows[next].changes.map((_, index) => index));
    setContents(false);
    setCleanup(false);
    setPreviewed([]);
    setApplied([]);
    setConfirmation('');
    setNotice('Choose a task, then prepare a proposal. Nothing has run.');
  }
  function confirm() {
    if (confirmation === 'preview') {
      setPreviewed([...new Set([...previewed, ...selected])]);
      setNotice(
        'Selected private previews generated after confirmation. No files saved into the source folder.',
      );
    } else if (confirmation === 'apply') {
      setApplied([...selected]);
      setPhase('applied');
      setNotice('Only the selected changes were applied after your confirmation.');
    } else if (confirmation === 'undo') {
      setPhase('undone');
      setNotice(
        'Changes undone after confirmation. Original names restored; generated copies retained privately.',
      );
    }
    setConfirmation('');
  }
  return (
    <section className="habibi-demo not-prose" aria-label="Interactive file workflow">
      <header className="habibi-demo-heading">
        <div>
          <Badge variant="secondary">Interactive demo</Badge>
          <h3>Try a reviewed file action</h3>
          <p>Try with sample files. Your own files stay untouched.</p>
        </div>
        <Button variant="ghost" onClick={() => reset()}>
          Reset demo
        </Button>
      </header>
      <div className="habibi-demo-body">
        <label className="habibi-demo-field">
          Task
          <Select value={task} onValueChange={reset}>
            <SelectTrigger aria-label="Demo file task">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(workflows).map(([id, item]) => (
                <SelectItem key={id} value={id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="habibi-demo-request">
          <CatalogIcon name="folder" size={18} />
          <span>{workflow.request}</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="outline">@Demo Inbox</Badge>
              </TooltipTrigger>
              <TooltipContent>/Users/demo/Downloads/Demo Inbox</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {phase === 'draft' ? (
          <>
            <label className="habibi-demo-check">
              <Checkbox
                checked={contents}
                onCheckedChange={(value) => setContents(value === true)}
              />
              <span>
                Include readable contents
                <small>
                  Off by default. Preparing shares filenames and metadata; enable this to include
                  document text.
                </small>
              </span>
            </label>
            {task === 'cleanup' && (
              <label className="habibi-demo-check">
                <Checkbox
                  checked={cleanup}
                  onCheckedChange={(value) => setCleanup(value === true)}
                />
                <span>
                  Allow cleanup
                  <small>
                    Allows proposals to move copies to Trash. It does not approve a removal.
                  </small>
                </span>
              </label>
            )}
            <div className="habibi-demo-actions">
              <Button
                disabled={task === 'cleanup' && !cleanup}
                onClick={() => {
                  setPhase('planned');
                  setNotice(
                    'Proposal ready. No compression, conversion, rename, or removal has run.',
                  );
                }}
              >
                Prepare demo plan
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="habibi-demo-summary">
              <Badge variant="outline">
                {phase === 'planned'
                  ? 'Proposal only'
                  : phase === 'applied'
                    ? 'Confirmed changes'
                    : 'Undone'}
              </Badge>
              <small>
                {contents ? 'Readable contents included by choice' : 'Names and metadata only'}
              </small>
            </div>
            <div className="habibi-demo-changes" role="group" aria-label="Proposed file changes">
              {workflow.changes.map((change, index) => (
                <label key={change.before} className="habibi-demo-change">
                  <Checkbox
                    aria-label={`Select ${change.before}`}
                    checked={selected.includes(index)}
                    disabled={phase !== 'planned'}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked
                          ? [...selected, index]
                          : selected.filter((value) => value !== index),
                      )
                    }
                  />
                  <span>
                    <b>{change.before}</b>
                    <span className="habibi-demo-destination">
                      <CatalogIcon name="arrow-right" size={14} />
                      {change.after}
                    </span>
                    {change.detail && <small>{change.detail}</small>}
                    {workflow.conversion && (
                      <small>
                        {previewed.includes(index)
                          ? change.measured + ' · Private preview confirmed'
                          : 'Not processed. Requires confirmation.'}
                      </small>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <div className="habibi-demo-actions">
              {phase === 'planned' && (
                <>
                  {workflow.conversion && (
                    <Button
                      variant="outline"
                      disabled={!selected.length}
                      onClick={() => setConfirmation('preview')}
                    >
                      Review output preview
                    </Button>
                  )}
                  <Button disabled={!selected.length} onClick={() => setConfirmation('apply')}>
                    Review {selected.length} {selected.length === 1 ? 'change' : 'changes'}
                  </Button>
                </>
              )}
              {phase === 'applied' && (
                <Button variant="outline" onClick={() => setConfirmation('undo')}>
                  Undo these changes
                </Button>
              )}
            </div>
          </>
        )}
        <p className="habibi-demo-status" role="status">
          <CatalogIcon name="shield" size={18} />
          <span>{notice}</span>
        </p>
        <div className="habibi-demo-result" aria-label="Demo source folder">
          <b>Source folder</b>
          <ul>
            {workflow.changes.map((change, index) => (
              <li key={change.before}>
                {phase === 'applied' && applied.includes(index)
                  ? task === 'cleanup'
                    ? 'invoice.pdf — original kept; copy moved to Trash'
                    : workflow.conversion
                      ? change.before + ' + ' + change.after
                      : change.after
                  : change.before}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <WorkflowConfirmation
        action={confirmation}
        count={selected.length}
        onConfirm={confirm}
        onCancel={() => {
          setConfirmation('');
          setNotice('Cancelled. No additional action ran.');
        }}
      />
    </section>
  );
}
