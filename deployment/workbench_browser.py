"""Start website sessions after Nginx authenticates a form or link request."""

import argparse
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler
import json
import re
from secrets import token_urlsafe
from threading import Lock
from time import monotonic
from urllib.parse import unquote


PREFIX = "/_workbench/browser"
COOKIE = "__Host-llmr-browser"
EMBEDDED_COOKIE = "__Host-llmr-browser-embedded"
LINK_TTL = 180
SESSION_TTL = 3600
MAX_PAYLOAD = 4096
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录投研工作台</title>
  <link rel="stylesheet" href="/_workbench/browser/login.css">
  <script src="/_workbench/browser/login.js" defer></script>
</head>
<body>
  <main>
    <h1>登录投研工作台</h1>
    <p id="status" role="status">正在准备登录…</p>
    <form id="login" method="post" action="/_workbench/browser/password" hidden>
      <label>账号 <input id="username" name="username" autocomplete="username" maxlength="128" required></label>
      <label>密码 <input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required></label>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>
""".encode("utf-8")

STYLE = b"""* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background: #f3f6fa; color: #17233b; font: 16px/1.5 system-ui, sans-serif; }
main { width: min(100%, 390px); padding: 32px; background: white; border: 1px solid #dce4ef;
  border-radius: 12px; box-shadow: 0 12px 32px #17233b0d; }
h1 { margin: 0 0 20px; font-size: 24px; }
p { margin: 0 0 16px; color: #49576c; }
p:empty { display: none; }
form:not([hidden]) { display: grid; gap: 16px; }
label { display: grid; gap: 6px; }
input, button { font: inherit; border-radius: 6px; padding: 10px 12px; }
input { width: 100%; border: 1px solid #9aa9bf; }
button { background: #244c88; color: white; border: 0; cursor: pointer; }
button:disabled { opacity: .6; cursor: wait; }
button:focus-visible, input:focus-visible { outline: 2px solid #2f6abd; outline-offset: 2px; }
"""

SCRIPT = """const prefix = "/_workbench/browser";
const notice = document.querySelector("#status");
const form = document.querySelector("#login");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const submit = form.querySelector("button");
const linkPage = location.pathname === prefix + "/login";
const ticket = linkPage ? location.hash.slice(1) : "";
const target = linkPage ? "/" : location.pathname + location.search + location.hash;

function showForm(message = "") {
  notice.textContent = message;
  form.hidden = false;
  username.focus();
}

async function enter(route, payload, headers = {}) {
  const response = await fetch(prefix + route, {
    method: "POST",
    headers: {"Content-Type": "application/json", ...headers},
    body: JSON.stringify(payload),
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error();
  const result = await response.json();
  const next = new URL(result.target, location.origin);
  if (next.origin !== location.origin) throw new Error();
  // A same-URL fragment navigation can leave the login document in place.
  if (next.href === location.href) location.reload();
  else location.replace(next.href);
  return true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  notice.textContent = "正在登录…";
  try {
    const bytes = new TextEncoder().encode(username.value + ":" + password.value);
    const authorization = "Basic " + btoa(String.fromCharCode(...bytes));
    if (await enter("/password", {target}, {"Authorization": authorization})) return;
    notice.textContent = "账号或密码有误，请重试。";
    password.focus();
  } catch {
    notice.textContent = "暂时无法登录，请再试一次。";
  } finally {
    password.value = "";
    submit.disabled = false;
  }
});

if (ticket) {
  history.replaceState(null, "", location.pathname);
  notice.textContent = "正在打开投研工作台…";
  enter("/session", {ticket}).then((entered) => {
    if (!entered) showForm("链接已用过或过期，请登录工作台。");
  }).catch(() => showForm("暂时无法使用链接，请登录工作台。"));
} else {
  showForm();
}
""".encode("utf-8")


def valid_target(target):
    if not isinstance(target, str) or len(target) > 2048:
        return False
    decoded = unquote(target)
    return (
        decoded.startswith("/")
        and not decoded.startswith("//")
        and "\\" not in decoded
        and not decoded.startswith(PREFIX)
        and not any(ord(char) < 32 or ord(char) == 127 for char in decoded)
        and target.startswith("/")
    )


class BrowserSessions:
    def __init__(self):
        self.links = {}
        self.sessions = {}
        self.lock = Lock()

    def issue(self, target):
        with self.lock:
            now = monotonic()
            self.links = {key: link for key, link in self.links.items() if link[1] > now}
            if len(self.links) >= 1024:
                return None
            ticket = token_urlsafe(32)
            self.links[ticket] = (target, now + LINK_TTL)
            return ticket

    def redeem(self, ticket):
        with self.lock:
            now = monotonic()
            link = self.links.pop(ticket, None)
            if link is None or link[1] <= now:
                return None
            return link[0], self._new_session(now)

    def sign_in(self):
        with self.lock:
            return self._new_session(monotonic())

    def _new_session(self, now):
        self.sessions = {key: expires for key, expires in self.sessions.items() if expires > now}
        session = token_urlsafe(32)
        self.sessions[session] = now + SESSION_TTL
        return session

    def authorized(self, session):
        with self.lock:
            return self.sessions.get(session, 0) > monotonic()


class BrowserHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def respond(self, status, body=b"", *, content_type="application/json; charset=utf-8", cookies=(), file_preview=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        ancestors = "file: 'self'" if file_preview else "'none'"
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            f"form-action 'self'; frame-ancestors {ancestors}; base-uri 'none'",
        )
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        try:
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/login":
            return self.respond(
                200, PAGE, content_type="text/html; charset=utf-8",
                file_preview=self.headers.get("Sec-Fetch-Dest") == "iframe",
            )
        if self.path == "/login.js":
            return self.respond(200, SCRIPT, content_type="application/javascript; charset=utf-8")
        if self.path == "/login.css":
            return self.respond(200, STYLE, content_type="text/css; charset=utf-8")
        if self.path == "/check":
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
            except CookieError:
                return self.respond(401)
            allowed = any(
                self.server.sessions.authorized(cookie[name].value)
                for name in (COOKIE, EMBEDDED_COOKIE) if name in cookie
            )
            return self.respond(204 if allowed else 401)
        return self.respond(404)

    do_HEAD = do_GET

    def do_POST(self):
        if self.path not in ("/link", "/password", "/session"):
            return self.respond(404)
        if self.path != "/link" and self.headers.get("Origin") != self.server.origin:
            return self.respond(403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_PAYLOAD or self.headers.get_content_type() != "application/json":
                raise ValueError
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, UnicodeError):
            return self.respond(400)

        if self.path in ("/link", "/password"):
            target = body.get("target", "/")
            if not valid_target(target):
                return self.respond(400)
            if self.path == "/password":
                return self.start_session(target, self.server.sessions.sign_in())
            ticket = self.server.sessions.issue(target)
            if ticket is None:
                return self.respond(429)
            url = f"{self.server.origin}{PREFIX}/login#{ticket}"
            return self.respond(200, json.dumps({"url": url, "expires_in": LINK_TTL}).encode())

        ticket = body.get("ticket")
        grant = self.server.sessions.redeem(ticket) if isinstance(ticket, str) and TOKEN.fullmatch(ticket) else None
        if grant is None:
            return self.respond(401)
        return self.start_session(*grant)

    def start_session(self, target, session):
        attributes = f"Path=/; Max-Age={SESSION_TTL}; HttpOnly; Secure"
        cookies = (
            f"{COOKIE}={session}; {attributes}; SameSite=Lax",
            f"{EMBEDDED_COOKIE}={session}; {attributes}; SameSite=None; Partitioned",
        )
        return self.respond(200, json.dumps({"target": target}).encode(), cookies=cookies)


def main():
    from socketserver import ThreadingMixIn, UnixStreamServer

    class BrowserServer(ThreadingMixIn, UnixStreamServer):
        daemon_threads = True
        # A fresh Web page fans out to many parallel cookie checks.
        request_queue_size = 256

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--origin", required=True)
    args = parser.parse_args()
    with BrowserServer(args.socket, BrowserHandler) as server:
        server.origin = args.origin
        server.sessions = BrowserSessions()
        server.serve_forever()


if __name__ == "__main__":
    main()
