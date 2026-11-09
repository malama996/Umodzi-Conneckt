export const umodziTheme = {
  colors: {
    navy: '#0B1F3A',
    deepNavy: '#082F3C',
    teal: '#0F9D8A',
    deepTeal: '#007F83',
    coral: '#F26B5B',
    background: '#F5F8FA',
    white: '#FFFFFF',
    text: '#243746',
    // Reconciled with globals.css `--muted` (the live source of truth, applied
    // via CSS variables). Was #647786, which is 4.15:1 on --bg — below WCAG AA;
    // globals.css already darkened it to #5a6e7d (4.99:1). Kept in sync here so
    // this mirror never reintroduces the low-contrast value.
    muted: '#5A6E7D',
    border: '#DCE5EA',
    success: '#16845B',
    warning: '#D99100',
    error: '#C83E4D',
  },
  radius: { card: '14px', control: '10px' },
} as const;
