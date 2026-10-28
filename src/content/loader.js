// Classic content script: loads the ES-module implementation from the
// extension package (content scripts declared in the manifest cannot be
// modules themselves).
(async () => {
  try {
    const { start } = await import(chrome.runtime.getURL('src/content/main.js'));
    start();
  } catch (err) {
    console.warn('[ChatGPT Timeline] tracker failed to start', err);
  }
})();
