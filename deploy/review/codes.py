"""Store-review pairing page: shows the hub address and a fresh pairing code.

nginx serves it at /review behind a password and a rate limit. It asks the
review hub for a code with the hub's admin token and keeps nothing.
"""

import html
import json
import os
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ADDRESS = os.environ["ARCA_REVIEW_ADDRESS"]
HUB = os.environ.get("ARCA_REVIEW_HUB", "http://127.0.0.1:17841")
PORT = int(os.environ.get("ARCA_REVIEW_PAGE_PORT", "8791"))
TOKEN_FILE = os.environ.get("ARCA_REVIEW_TOKEN_FILE", "/etc/arca-review/admin-token")

STYLE = """
:root { --ink: #17231d; --muted: #5b6b62; --line: #d6ddd7; --paper: #f4f6f1; --card: #fff; --accent: #244d3e; --warn: #9a3b2c; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6ece7; --muted: #9fb0a6; --line: #2c3a33; --paper: #0f1512; --card: #18211c; --accent: #8fc7ad; --warn: #e59a8a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 24px; margin: 0 0 4px; }
p, li { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin: 20px 0; }
.label { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 6px; }
.value { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.address { font: 17px ui-monospace, monospace; word-break: break-all; }
.code { font: 600 44px ui-monospace, monospace; letter-spacing: .12em; }
button { font: inherit; border-radius: 10px; border: 1px solid var(--accent); padding: 10px 16px; background: transparent; color: var(--accent); cursor: pointer; }
button.primary { background: var(--accent); color: var(--card); width: 100%; padding: 14px; font-weight: 600; }
button:disabled { opacity: .45; cursor: default; }
.bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 12px; }
.bar span { display: block; height: 100%; background: var(--accent); }
.expired { color: var(--warn); }
.dead { opacity: .35; }
ol { padding-left: 20px; }
"""

SCRIPT = """
document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
  await navigator.clipboard.writeText(button.dataset.copy);
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = 'Copy'), 1500);
}));
const left = document.getElementById('left');
if (left) {
  const expires = Date.now() + Number(left.dataset.left), total = 600000;
  const bar = document.querySelector('.bar span');
  const tick = () => {
    const ms = Math.max(0, expires - Date.now());
    const s = Math.ceil(ms / 1000);
    left.textContent = `Valid for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · works once`;
    bar.style.width = `${(ms / total) * 100}%`;
    if (ms > 0) return setTimeout(tick, 1000);
    left.textContent = 'This code has expired. Generate a new one below.';
    left.className = 'expired';
    document.querySelectorAll('.code, [data-copy-code]').forEach((node) => { node.disabled = true; node.classList.add('dead'); });
  };
  tick();
}
"""


def copy_row(label, value, css, data=""):
    shown = html.escape(value)
    return (
        f'<p class="label">{label}</p><div class="value"><span class="{css}">{shown}</span>'
        f'<button type="button" data-copy="{html.escape(value.replace(" ", ""))}" {data}>Copy</button></div>'
    )


def page(code=None, left=None, error=None):
    body = [
        "<h1>Arca review hub</h1>",
        "<p>Pair the Arca app with this demo hub. It holds sample photos, videos and documents.</p>",
        '<div class="card">',
        copy_row("Hub address", ADDRESS, "address"),
        "</div>",
    ]
    if code:
        pretty = f"{code[:3]} {code[3:]}"
        body += [
            '<div class="card">',
            copy_row("Pairing code", pretty, "code", "data-copy-code"),
            f'<p id="left" data-left="{left}"></p><div class="bar"><span></span></div>',
            "<p>Generating another code replaces this one.</p>",
            "</div>",
        ]
    if error:
        body.append(f'<p class="expired">{html.escape(error)}</p>')
    body += [
        '<form method="post" action="/review">',
        f'<button class="primary" type="submit">{"Generate a new code" if code else "Generate pairing code"}</button>',
        "</form>",
        '<div class="card"><p class="label">In the app</p><ol>',
        "<li>Open Arca and tap <b>Get started</b>.</li>",
        "<li>Enter the <b>Hub address</b> and the <b>Pairing code</b> shown above, and any name for the device.</li>",
        "<li>Tap <b>Pair this phone</b> (or <b>Pair this tablet</b>).</li>",
        "<li>Choose the folders to keep on the device and tap <b>Download</b>.</li>",
        "</ol><p>Photos opens as a gallery. In Documents, open a file's history to see earlier versions; "
        "Phone uploads is where a linked photo album uploads.</p>"
        "<p>Other reviewers can see what you upload here; everything is deleted after the review.</p></div>",
    ]
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>Arca review hub</title><style>{STYLE}</style></head><body><main>"
        + "".join(body)
        + f"</main><script>{SCRIPT}</script></body></html>"
    )


def new_code():
    with open(TOKEN_FILE, encoding="utf-8") as handle:
        token = handle.read().strip()
    request = urllib.request.Request(
        f"{HUB}/v1/pairing",
        data=json.dumps({"name": "App Review"}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    return result["code"], int(result["expires"])


class Handler(BaseHTTPRequestHandler):
    def send_page(self, status, content):
        data = content.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
            "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send_page(200, page())

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and origin != ADDRESS:
            return self.send_page(403, page(error="Open this page directly to generate a code."))
        try:
            code, expires = new_code()
        except Exception as error:
            print("pairing code failed:", repr(error), file=sys.stderr, flush=True)
            return self.send_page(503, page(error="The review hub is not answering. Try again in a minute."))
        self.send_page(200, page(code, max(0, expires - int(time.time() * 1000))))

    def log_message(self, fmt, *args):
        print(time.strftime("%Y-%m-%d %H:%M:%S"), self.command, self.path, flush=True)


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
