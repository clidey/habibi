export const workflows = {
  rename: {
    label: 'Rename receipts',
    request: 'Rename the receipts in @Demo Inbox by vendor and date.',
    changes: [
      { before: 'scan-01.pdf', after: '2026-11-06-demo-cafe.pdf' },
      { before: 'scan-02.pdf', after: '2026-11-05-demo-studio.pdf' },
      { before: 'scan-03.pdf', after: '2026-11-04-demo-market.pdf' },
    ],
  },
  organize: {
    label: 'Organize a folder',
    request: 'Organize @Demo Inbox into sensible folders. Keep file extensions.',
    changes: [
      { before: 'invoice.pdf', after: 'Receipts/invoice.pdf' },
      { before: 'portrait.jpg', after: 'Photos/portrait.jpg' },
      { before: 'proposal.docx', after: 'Documents/proposal.docx' },
    ],
  },
  compress: {
    label: 'Compress an image',
    request: 'Make a JPEG copy of @Photo, 1,200 pixels wide and under 500 KB.',
    conversion: true,
    changes: [
      {
        before: 'photo.png',
        after: 'photo-small.jpg',
        detail: '1,200 px · quality 65 · target 500 KB',
        measured: '2.4 MB → 420 KB',
      },
    ],
  },
  pdf: {
    label: 'Reorder PDF pages',
    request: 'Make a new copy of @Report with pages 3, 1, and 2 in that order.',
    conversion: true,
    changes: [
      {
        before: 'report.pdf',
        after: 'report-reordered.pdf',
        detail: 'Page order: 3, 1, 2',
        measured: '3 pages · 240 KB',
      },
    ],
  },
  cleanup: {
    label: 'Review duplicate cleanup',
    request: 'Find identical files in @Demo Inbox and suggest which copy to keep.',
    changes: [
      {
        before: 'invoice-copy.pdf',
        after: 'Trash',
        detail: 'Identical original invoice.pdf stays in the folder.',
      },
    ],
  },
};
