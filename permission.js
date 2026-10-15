navigator.mediaDevices.getUserMedia({ audio: true })
  .then((s) => { s.getTracks().forEach((t) => t.stop()); m.textContent = '✅ Granted. Close this tab and press Start in the side panel.'; })
  .catch((e) => { m.textContent = '❌ ' + e.message + ' — allow the mic via the lock icon in the address bar, then reload.'; });
