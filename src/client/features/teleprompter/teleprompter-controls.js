export function updateTeleprompterRange(input, output) {
  const percent = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100;
  input.style.setProperty('--range-progress', `${percent}%`);
  input.setAttribute('aria-valuetext', output.textContent);
}
