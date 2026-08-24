/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#070b16',
          900: '#0b1020',
          850: '#0e1428',
          800: '#131a30',
          700: '#1c2440',
          600: '#293353',
          500: '#3a4569',
        },
        accent: {
          DEFAULT: '#4cc2ff',
          soft: '#8bd8ff',
          deep: '#1b6fa8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        'pulse-bar': { '0%,100%': { opacity: '0.4' }, '50%': { opacity: '1' } },
      },
      animation: {
        'fade-in': 'fade-in .25s ease-out both',
      },
    },
  },
  plugins: [],
}
