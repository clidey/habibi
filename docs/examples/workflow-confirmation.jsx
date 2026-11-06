import React, { useLayoutEffect, useRef } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@clidey/ux';
export function WorkflowConfirmation({ action, onCancel, onConfirm, count }) {
  const cancelButton = useRef(null);
  // Dory aliases React to Preact; keep Escape and focus reliable across portals.
  useLayoutEffect(() => {
    if (!action) return;
    const previousFocus = document.activeElement;
    cancelButton.current?.focus();
    const dismiss = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', dismiss, true);
    return () => {
      document.removeEventListener('keydown', dismiss, true);
      previousFocus?.focus?.();
    };
  }, [action]);
  const copy = {
    preview: [
      'Generate selected output previews?',
      'Convert the selected fictional files into private previews. This does not save anything into the source folder.',
      'Generate previews',
    ],
    apply: [
      `Apply ${count} selected ${count === 1 ? 'change' : 'changes'}?`,
      'Only the files you selected will change. Unchecked files stay as they are.',
      'Apply selected changes',
    ],
    undo: [
      'Undo these changes?',
      'Restore the original names and locations. Generated copies are kept rather than deleted.',
      'Undo changes',
    ],
  }[action];
  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{copy?.[0]}</DialogTitle>
          <DialogDescription>{copy?.[1]}</DialogDescription>
        </DialogHeader>
        <p className="habibi-demo-dialog-note">Documentation demo · fictional files only</p>
        <DialogFooter>
          <Button ref={cancelButton} variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>{copy?.[2]}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
