async function ask() {
  const out = document.getElementById('out');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    out.textContent = '✅ Microphone access granted. You can close this tab and start recording.';
  } catch (e) {
    out.textContent = `❌ ${e.name}: ${e.message}. If blocked, click the lock icon in the address bar and allow the microphone, then press "Ask again".`;
  }
}
document.getElementById('retry').onclick = ask;
ask();
