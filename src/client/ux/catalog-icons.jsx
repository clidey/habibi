import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogIcon } from '@clidey/ux';
import { icons } from '@clidey/ux/icons';
import aliases from '../data/icon-aliases.json';
import whatsappBrand from '../../../assets/icons/whatsapp.svg';

/** UX catalog icons, with the user-approved WhatsApp brand outline. */
let stylesReady = false;
export function createIcons() {
  if (!stylesReady) {
    for (const name of ['search', 'trash', 'upload', 'check-circle'])
      document.documentElement.style.setProperty(`--ux-icon-${name}`, `url("${icons[name]}")`);
    stylesReady = true;
  }
  document.querySelectorAll('i[data-ux-icon]').forEach((placeholder) => {
    const name = placeholder.getAttribute('data-ux-icon');
    const glyph = aliases[name] || name;
    if (!Object.hasOwn(icons, glyph)) return;
    const brand = name === 'whatsapp';
    const mask = brand ? `url("${whatsappBrand}") center / contain no-repeat` : undefined;
    const template = document.createElement('template');
    template.innerHTML = renderToStaticMarkup(
      <CatalogIcon
        name={glyph}
        className={`ux-catalog-icon ${placeholder.className}`}
        data-ux-icon={name}
        data-ux-glyph={brand ? 'whatsapp-brand' : glyph}
        data-icon-source={brand ? 'whatsapp-brand' : 'ux-catalog'}
        style={brand ? { mask, WebkitMask: mask } : undefined}
      />,
    );
    placeholder.replaceWith(template.content.firstElementChild);
  });
}
