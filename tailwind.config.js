/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#080b0f',
          900: '#0d1117',
          850: '#11171f',
          800: '#161d27',
          700: '#1f2833',
          600: '#2c3743',
          500: '#3d4a58',
        },
        brand: {
          DEFAULT: '#14b8a6',
          soft: '#5eead4',
          deep: '#0f766e',
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
