import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, Button, Input, Kbd, TextArea } from '@clidey/ux';

function attributes(element) {
  const props = {};
  for (const attribute of element.attributes) {
    if (attribute.name.startsWith('on') || attribute.name === 'style') continue;
    const name =
      {
        class: 'className',
        for: 'htmlFor',
        tabindex: 'tabIndex',
        'stroke-width': 'strokeWidth',
        readonly: 'readOnly',
        autofocus: 'autoFocus',
      }[attribute.name] || attribute.name;
    props[name] = ['disabled', 'hidden', 'multiple', 'required', 'readOnly', 'autoFocus'].includes(
      name,
    )
      ? true
      : attribute.value;
  }
  return props;
}

function node(child) {
  return child.nodeType === Node.TEXT_NODE
    ? child.textContent
    : child.nodeType === Node.ELEMENT_NODE
      ? React.createElement(
          child.localName === 'kbd'
            ? Kbd
            : child.matches(
                  'span.status-pill, span.verified, span.result-tag, span.permission, span.emoji-shortcut',
                )
              ? Badge
              : child.localName,
          child.matches(
            'span.status-pill, span.verified, span.result-tag, span.permission, span.emoji-shortcut',
          )
            ? { variant: 'outline', ...attributes(child) }
            : attributes(child),
          ...[...child.childNodes].map(node),
        )
      : null;
}

/** Upgrade plain controls to UX components before feature handlers bind. */
export function renderControls(markup) {
  if (!/<(?:button|input|textarea|span|kbd)\b/.test(markup)) return markup;
  const template = document.createElement('template');
  template.innerHTML = markup;
  const upgrade = (selector, slot, Component, props) => {
    const originals = [...template.content.querySelectorAll(selector)];
    if (!originals.length) return;
    const rendered = renderToStaticMarkup(
      <>
        {originals.map((element, index) => (
          <Component key={index} {...attributes(element)} {...props?.(element)} />
        ))}
      </>,
    );
    const upgraded = document.createElement('template');
    upgraded.innerHTML = rendered;
    const replacements = [...upgraded.content.querySelectorAll(`[data-slot="${slot}"]`)];
    if (replacements.length !== originals.length) return;
    originals.forEach((element, index) => {
      if (element.hasAttribute('style'))
        replacements[index].setAttribute('style', element.getAttribute('style'));
      element.replaceWith(replacements[index]);
    });
  };
  const buttons = [...template.content.querySelectorAll('button:not([data-slot="button"])')];
  if (buttons.length) {
    const rendered = renderToStaticMarkup(
      <>
        {buttons.map((button, index) => (
          <Button
            key={index}
            {...attributes(button)}
            className={`${button.className} habibi-control`}
          >
            {[...button.childNodes].map(node)}
          </Button>
        ))}
      </>,
    );
    const upgraded = document.createElement('template');
    upgraded.innerHTML = rendered;
    const replacements = [...upgraded.content.querySelectorAll('button[data-slot="button"]')];
    if (replacements.length === buttons.length)
      buttons.forEach((button, index) => {
        if (button.hasAttribute('style'))
          replacements[index].setAttribute('style', button.getAttribute('style'));
        button.replaceWith(replacements[index]);
      });
  }
  upgrade('input:not([data-slot]):not([type="checkbox"]):not([type="radio"])', 'input', Input);
  upgrade('textarea:not([data-slot])', 'textarea', TextArea, (element) => ({
    defaultValue: element.textContent,
  }));
  const badges = [
    ...template.content.querySelectorAll(
      'span.status-pill:not([data-slot]), span.verified:not([data-slot]), span.result-tag:not([data-slot]), span.permission:not([data-slot]), span.emoji-shortcut:not([data-slot])',
    ),
  ];
  if (badges.length) {
    const rendered = renderToStaticMarkup(
      <>
        {badges.map((badge, index) => (
          <Badge key={index} variant="outline" {...attributes(badge)}>
            {[...badge.childNodes].map(node)}
          </Badge>
        ))}
      </>,
    );
    const upgraded = document.createElement('template');
    upgraded.innerHTML = rendered;
    const replacements = [...upgraded.content.querySelectorAll('span[data-slot="badge"]')];
    if (replacements.length === badges.length)
      badges.forEach((badge, index) => badge.replaceWith(replacements[index]));
  }
  const shortcuts = [...template.content.querySelectorAll('kbd:not([data-slot])')];
  if (shortcuts.length) {
    const rendered = renderToStaticMarkup(
      <>
        {shortcuts.map((shortcut, index) => (
          <Kbd key={index} {...attributes(shortcut)}>
            {[...shortcut.childNodes].map(node)}
          </Kbd>
        ))}
      </>,
    );
    const upgraded = document.createElement('template');
    upgraded.innerHTML = rendered;
    const replacements = [...upgraded.content.querySelectorAll('kbd[data-slot="kbd"]')];
    if (replacements.length === shortcuts.length)
      shortcuts.forEach((shortcut, index) => shortcut.replaceWith(replacements[index]));
  }
  return template.innerHTML;
}

/** Render a command result through UX Button while preserving its data contract. */
export function renderResultButton(markup) {
  return renderControls(markup);
}
