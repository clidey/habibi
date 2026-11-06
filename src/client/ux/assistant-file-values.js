export const fileTaskLabels = {
  rename: 'Rename files',
  organize: 'Organize a folder',
  storage: 'Understand storage',
  duplicates: 'Find duplicates',
  pdf: 'Work with PDFs',
  compress: 'Compress or convert',
  extract: 'Extract to a spreadsheet',
  find: 'Find the right version',
};
export const fileBytes = (value) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KB`
      : value < 1024 ** 3
        ? `${(value / 1024 ** 2).toFixed(1)} MB`
        : `${(value / 1024 ** 3).toFixed(1)} GB`;
