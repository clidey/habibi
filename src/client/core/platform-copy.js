// User-facing names that differ per OS. The desktop shell sets
// `window.__habibiPlatform` ('macos' | 'windows' | 'linux') before any page
// script runs; a plain browser (tests, docs) reads as macOS.
const platform = () => window.__habibiPlatform || 'macos';
const pick = (names) => names[platform()] ?? names.linux;

export const onMac = () => platform() === 'macos';
/** "this Mac", "this PC" or "this computer". */
export const thisDevice = () => pick({ macos: 'this Mac', windows: 'this PC', linux: 'this computer' });
/** "macOS", "Windows" or "Linux". */
export const osName = () => pick({ macos: 'macOS', windows: 'Windows', linux: 'Linux' });
/** Where secrets are kept. */
export const credentialStore = () =>
  pick({ macos: 'macOS Keychain', windows: 'Windows Credential Manager', linux: 'your system keyring' });
/** The OS settings app. */
export const systemSettings = () => pick({ macos: 'System Settings', windows: 'Settings', linux: 'system settings' });
/** The OS file manager. */
export const fileManager = () => pick({ macos: 'Finder', windows: 'File Explorer', linux: 'your file manager' });
