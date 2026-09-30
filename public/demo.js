const output = document.getElementById('debug');

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.data?.type !== 'adestra-debug') return;
  output.textContent = `${new Date().toLocaleTimeString()}\n${JSON.stringify(event.data.debug, null, 2)}`;
});
