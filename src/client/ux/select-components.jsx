import React from 'react';
import { createRoot } from 'react-dom/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@clidey/ux';

function WebSearchSelect({ value, providers, onChange }) {
  return (
    <Select defaultValue={value} onValueChange={onChange}>
      <SelectTrigger aria-labelledby="web-search-label" className="web-search-ux-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="web-search-ux-menu">
        {providers.map((provider) => (
          <SelectItem key={provider.id} value={provider.id}>
            {provider.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function mountWebSearchSelect(host, props) {
  const root = createRoot(host);
  root.render(<WebSearchSelect {...props} />);
  return { unmount: () => root.unmount() };
}

const emptySelectValue = '__habibi_empty_select_value__';
function NativeSelect({ value, options, label, disabled, onChange }) {
  const selected = options.some((option) => option.value === value)
    ? value || emptySelectValue
    : undefined;
  const placeholder = options.find((option) => !option.value)?.label || 'Select…';
  return (
    <Select
      value={selected}
      disabled={disabled}
      onValueChange={(next) => onChange(next === emptySelectValue ? '' : next)}
    >
      <SelectTrigger className="ux-native-select-trigger" aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="ux-native-select-menu">
        {options.map((option, index) => (
          <SelectItem
            key={`${option.value}-${index}`}
            value={option.value || emptySelectValue}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function mountNativeSelect(host, props) {
  const root = createRoot(host);
  const update = (next) => root.render(<NativeSelect {...next} />);
  update(props);
  return { update, unmount: () => root.unmount() };
}
