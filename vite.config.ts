import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 5005,
      host: '0.0.0.0',
      watch: {
        ignored: ['**/db.json', '**/db.json.local.bak', '**/db.sandbox.*.json', '**/db.sandbox.*.json.local.bak']
      },
      proxy: {
        '/api': {
          target: 'http://localhost:3006',
          changeOrigin: true
        }
      }
    },
    preview: {
      port: parseInt(process.env.PORT || '5005'),
      host: '0.0.0.0',
      allowedHosts: true,
      proxy: {
        '/api': {
          target: 'http://localhost:3006',
          changeOrigin: true
        }
      }
    },
    plugins: [react()],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('jspdf') || id.includes('html2canvas')) {
                return 'pdf-vendor';
              }
              if (id.includes('xlsx')) {
                return 'xlsx-vendor';
              }
              if (id.includes('mermaid') || id.includes('cytoscape') || id.includes('katex')) {
                return 'diagram-vendor';
              }
              if (id.includes('react') || id.includes('react-dom') || id.includes('react-markdown')) {
                return 'react-vendor';
              }
            }
          }
        }
      }
    }
  };
});
