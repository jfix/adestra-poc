const form = document.getElementById('signup');
const input = document.getElementById('email');
const button = form.querySelector('button');
const result = document.getElementById('result');
const message = document.getElementById('message');
const retry = document.getElementById('retry');
const verificationStatus = document.getElementById('verification-status');
let widgetId;
let turnstileToken = '';
let busy = false;

function setBusy(busy) {
  input.disabled = busy;
  button.disabled = busy || !turnstileToken;
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

function clearVerification() {
  turnstileToken = '';
  button.disabled = true;
}

async function initializeTurnstile() {
  try {
    verificationStatus.textContent = 'Connecting...';
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Configuration unavailable');
    const { turnstileSiteKey } = await response.json();
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
    widgetId = window.turnstile.render('#turnstile', {
      sitekey: turnstileSiteKey,
      action: 'subscribe',
      size: 'flexible',
      callback(token) {
        turnstileToken = token;
        verificationStatus.textContent = '';
        button.disabled = busy;
      },
      'expired-callback'() {
        clearVerification();
        verificationStatus.textContent = 'Verification expired. Please verify again.';
        window.turnstile.reset(widgetId);
      },
      'error-callback'() {
        clearVerification();
        verificationStatus.textContent = 'Verification unavailable. Please reload to retry.';
      },
    });
    verificationStatus.textContent = '';
  } catch {
    clearVerification();
    verificationStatus.textContent = 'Verification unavailable. Please reload to retry.';
  }
}

retry.addEventListener('click', () => {
  result.hidden = true;
  form.hidden = false;
  input.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !turnstileToken) return;
  busy = true;
  setBusy(true);

  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: input.value.trim(), turnstileToken }),
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
    busy = false;
    clearVerification();
    if (widgetId !== undefined) window.turnstile.reset(widgetId);
    setBusy(false);
  }
});

initializeTurnstile();
