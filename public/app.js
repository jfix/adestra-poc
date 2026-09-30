const form = document.getElementById('signup');
const input = document.getElementById('email');
const button = form.querySelector('button');
const result = document.getElementById('result');
const message = document.getElementById('message');
const retry = document.getElementById('retry');

function setBusy(busy) {
  input.disabled = busy;
  button.disabled = busy;
  button.textContent = busy ? 'Sending…' : 'Subscribe';
}

function show(text, ok) {
  message.textContent = text;
  message.title = text;
  result.className = ok ? 'ok' : 'error';
  retry.hidden = ok;
  form.hidden = true;
  result.hidden = false;
  if (!ok) retry.focus();
}

retry.addEventListener('click', () => {
  result.hidden = true;
  form.hidden = false;
  input.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true);

  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input.value.trim() }),
    });
    const data = await res.json();
    if (data.debug) {
      console.debug('Adestra debug', data.debug);
      // Only delivered when the host page is on the same origin (i.e. /demo)
      window.parent.postMessage({ type: 'adestra-debug', debug: data.debug }, location.origin);
    }
    show(data.message, data.ok);
    if (data.ok) form.reset();
  } catch {
    show('Could not reach the server. Please try later.', false);
  } finally {
    setBusy(false);
  }
});
