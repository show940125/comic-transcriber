document.getElementById('reader')!.onclick = () => { void chrome.tabs.create({ url: chrome.runtime.getURL('/reader.html') }); };
document.getElementById('settings')!.onclick = () => { void chrome.runtime.openOptionsPage(); };
document.getElementById('grant')!.onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.id) throw new Error('請在漫畫網站使用此功能');
    const url = new URL(tab.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('請開啟 HTTP(S) 漫畫網站');
    if (await chrome.permissions.request({ origins: [`${url.origin}/*`] })) { await chrome.tabs.reload(tab.id); document.getElementById('status')!.textContent = '已授權並重新整理。'; }
  } catch (e) { document.getElementById('status')!.textContent = String(e); }
};
