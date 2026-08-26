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
          // Sampled from the logo file: the teal in QUOTIENT and the navy in LAND.
          DEFAULT: '#01A3A8',
          // Teal on white is too light to read as text, so links and emphasis
          // use the deep shade; the bright one stays for fills. The deep shade
          // is the logo's navy rather than a darker teal, which is what puts
          // the second half of the mark into the interface.
          soft: '#7fd9db',
          deep: '#143366',
          tint: '#e9f5f6',
          // The navy pushed darker, for grounds the mark sits on: the marketing
          // hero and footer. Deep enough that white type clears AA comfortably.
          night: '#0c1f42',
          // Hairlines and outlined buttons on that ground.
          edge: '#22406f',
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
