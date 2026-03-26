import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'warm-beige': '#F5E6D3',
        'olive-green': '#B8B8A6',
        'soft-apricot': '#F4DCC4',
        'warm-grey': '#D4CFC9',
        'sage': '#A8B5A0',
      },
    },
  },
  plugins: [typography],
}
