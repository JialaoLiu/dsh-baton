// What scripts/privacy-check.mjs looks for. Kept in a file of their own: the patterns
// themselves would match, so this file is the only one the check skips.

// Placeholder user names that tests and docs use on purpose.
const PLACEHOLDER = new Set(['a', 'b', 'x', 'me', 'you', 'user', 'name', 'runner', 'USER', 'USERNAME', 'example', 'alice', 'bob', 'Shared'])

export const rules = [
  // Not after a host name, so a URL such as example.com/home/page is not a home folder.
  { name: 'home folder path', re: /(?:(?<![\w.-])\/(?:Users|home)\/|[A-Za-z]:[\\/]+[Uu][Ss][Ee][Rr][Ss][\\/]+)([^\\/\s'"`<>{}$]+)/g, ok: (m) => PLACEHOLDER.has(m[1]) || m[1].length === 1 || m[1].startsWith('%') || /^\.\.\.|^…/.test(m[1]) },
  { name: 'mounted drive', re: /\/Volumes\/[^\s'"`]+/g },
  { name: 'LAN address', re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'Codex or Claude session file', re: /\.codex[\\/]+sessions[\\/]+20|\.claude[\\/]+projects[\\/]+-/g },
]

export const MEDIA = /\.(png|jpe?g|gif|webp|mov|mp4|webm|heic)$/i
