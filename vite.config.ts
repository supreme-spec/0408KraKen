import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },

    server: {
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
       watch: process.env.DISABLE_HMR === 'true' ? null : {
         // Игнорируем постоянно меняющиеся логи/билды, чтобы не дёргать HMR лишний раз
         ignored: [
           '**/logs/**',
           '**/node_modules/**',
           '**/.git/**',
           '**/dist/**',
           '**/venv/**',
           '**/venv_kraken/**',
           '**/venv_new/**',
           '**/calibration/**',
           '**/backend/**',
           '**/assets/**',
           '**/models/**',
         ],
       },
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:3000',
          ws: true,
        },
        '/photos': { target: 'http://localhost:3000', changeOrigin: true },
        '/snapshots': { target: 'http://localhost:3000', changeOrigin: true },
        '/recordings': { target: 'http://localhost:3000', changeOrigin: true },
      },
    },

    build: {
      // Поднимаем лимит предупреждения — фронтенд с face-api моделями большой
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: {
            // React ядро
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            // UI библиотеки
            'vendor-ui': ['lucide-react', 'motion'],
          },
        },
      },
    },
  };
});
