import React from 'react';
import { IconMoreH, IconClose, IconDownload, IconRefresh, IconColumns, IconPlay } from '@clidey/ux';

const glyphs = {
  more: IconMoreH,
  close: IconClose,
  download: IconDownload,
  restart: IconRefresh,
  pause: IconColumns,
  play: IconPlay,
};

/** Named icons are provided by the published UX catalog, with no local artwork. */
export function UxGlyph({ name, size = 18 }) {
  const Glyph = glyphs[name];
  if (!Glyph) throw new Error(`Unknown UX action icon: ${name}`);
  return (
    <Glyph
      data-slot="icon"
      className="habibi-glyph"
      size={size}
      style={{ width: size, height: size }}
    />
  );
}
