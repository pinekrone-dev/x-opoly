/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Semantic rather than numbered, so a component says what a colour is
        // for instead of how dark it is. That is what made the switch from a
        // dark interface to a light one a rename rather than a rewrite.
        paper: '#f6f8fa', // the page behind everything
        surface: '#ffffff', // panels and cards
        sunken: '#f1f5f9', // inset wells, inputs, hover
        line: {
          DEFAULT: '#e2e8f0',
          strong: '#cbd5e1',
        },
        ink: '#0f172a', // primary text
        body: '#334155', // secondary text
        muted: '#64748b', // labels and captions
        faint: '#94a3b8', // the quietest legible text
        brand: {
          DEFAULT: '#14b8a6',
          // Teal on white is too light to read as text, so links and emphasis
          // use the deep shade; the bright one stays for fills.
          soft: '#5eead4',
          deep: '#0f766e',
          tint: '#f0fdfa',
        },
        stage: {
          prospect: '#94a3b8',
          touring: '#38bdf8',
          loi: '#fbbf24',
          contract: '#34d399',
          passed: '#64748b',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { 'fade-in': 'fade-in .2s ease-out both' },
    },
  },
  plugins: [],
}
