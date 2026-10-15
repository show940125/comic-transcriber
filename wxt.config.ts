import { defineConfig } from 'wxt';
export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  svelte: { vite: { emitCss: false } },
  manifest: {
    name: '墨譯 Comic Transcriber', description: '日文漫畫本機 OCR、繁體中文翻譯與可校正嵌字。',
    permissions: ['storage', 'contextMenus', 'offscreen', 'activeTab','scripting'],
    cross_origin_embedder_policy:{value:'require-corp'},
    cross_origin_opener_policy:{value:'same-origin'},
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*', 'https://translate.googleapis.com/*', 'http://127.0.0.1/*', 'http://localhost/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    web_accessible_resources: [{ resources: ['reader.html', 'assets/*'], matches: ['<all_urls>'] }],
  },
  vite: () => ({define:{__COMIC_BUILD__:JSON.stringify(new Date().toISOString())},build: { chunkSizeWarningLimit: 1800 }, worker: { format: 'es' } }),
});
