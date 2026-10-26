import catalog from '../../../assets/whodb-icons.json';

/** Hydrate trusted, bundled WhoDB SVGs once; unrecognized names never become markup. */
window.whodbIcons = {
  createIcons() {
    document.querySelectorAll('i[data-whodb-icon]').forEach((placeholder) => {
      const name = placeholder.getAttribute('data-whodb-icon');
      if (!Object.hasOwn(catalog.aliases, name)) return;
      const glyph = catalog.aliases[name];
      const template = document.createElement('template');
      template.innerHTML = catalog.icons[glyph];
      const svg = template.content.firstElementChild;
      svg.classList.add('whodb-icon');
      for (const value of placeholder.classList) svg.classList.add(value);
      svg.setAttribute('data-whodb-icon', name);
      svg.setAttribute('data-whodb-glyph', glyph);
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      if (name === 'arrow-left') svg.style.transform = 'scaleX(-1)';
      placeholder.replaceWith(svg);
    });
  },
};
