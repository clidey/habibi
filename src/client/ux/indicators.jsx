import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { Progress, Spinner, Switch } from '@clidey/ux';

export function mountProgress(host, initialValue = 0) {
  const root = createRoot(host);
  const render = (value) =>
    root.render(<Progress value={value} max={100} aria-label="Downloading WhatsApp support" />);
  render(initialValue);
  return { setValue: render, unmount: () => root.unmount() };
}

export function mountSwitch(host, { checked, disabled, label, onChange }) {
  const root = createRoot(host);
  const render = (nextChecked, nextDisabled = disabled) => {
    checked = nextChecked;
    disabled = nextDisabled;
    root.render(
      <Switch
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onCheckedChange={onChange}
      />,
    );
  };
  render(checked);
  return { update: render, unmount: () => root.unmount() };
}

export function renderSpinner(small = false) {
  return renderToStaticMarkup(
    <Spinner size={small ? 18 : 24} className="habibi-spinner" aria-hidden="true" />,
  );
}
