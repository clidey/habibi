/** Opens a native Quick Look preview for a local file. */
export function previewFile(path, name, notify) {
  fetch('/api/quick-look', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
    .then((response) => response.json())
    .then((result) =>
      notify(
        result.ok
          ? result.state === 'opened'
            ? `Quick Look: ${name}`
            : 'Quick Look closed'
          : 'Could not open Quick Look',
      ),
    )
    .catch(() => notify('Could not open Quick Look'));
}
