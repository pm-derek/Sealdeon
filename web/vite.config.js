import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base './' keeps assets relative so the site works at any GitHub Pages
// project path (hash routing, no server rewrites needed).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})
