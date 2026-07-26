/** ログイン画面。 */

const form = document.getElementById("login-form");
const password = document.getElementById("password");
const submit = document.getElementById("submit");
const error = document.getElementById("error");

function showError(message, kind = "") {
    error.textContent = message;
    error.className = `notice ${kind}`;
    error.hidden = false;
}

// 既にログイン済みならそのまま入る（ブックマークから来たとき）
fetch("/api/session")
    .then(r => r.json())
    .then(s => {
        if (s.authenticated) location.href = "/";
        else if (!s.configured) {
            // ⚠️ ここでブラウザから設定させない。LAN 内で先に到達した人が決められてしまう
            showError(
                "パスワードがまだ設定されていません。Pi で sudo /opt/odelic-web/install.sh を実行してください。",
                "bad",
            );
        }
    })
    .catch(() => {});

form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
        const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Odelic-Request": "1" },
            body: JSON.stringify({ password: password.value }),
        });
        if (res.ok) {
            location.href = "/";
            return;
        }
        const body = await res.json().catch(() => ({}));
        // ⚠️ 失敗の理由をそのまま出す（サーバ側で回数に応じて遅延している）
        showError(body.detail ?? `ログインできませんでした（HTTP ${res.status}）`, "bad");
        password.value = "";
        password.focus();
    } catch (e) {
        showError(`サーバに繋がりません: ${e instanceof Error ? e.message : String(e)}`, "bad");
    } finally {
        submit.disabled = false;
    }
});
