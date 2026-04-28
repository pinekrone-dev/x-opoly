/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          900: "#03050f",
          800: "#050a1c",
          700: "#0f1b3a",
          600: "#1a2245"
        },
        gold: {
          DEFAULT: "#d4af37",
          light: "#f5e3a0"
        }
      },
      fontFamily: {
        display: ["'Playfair Display'", "Georgia", "serif"],
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"]
      }
    }
  },
  plugins: []
}
