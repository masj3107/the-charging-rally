(() => {
  const LEDGER_PATTERN = /(^|\/)data\/ledger\.json(?:[?#].*)?$/;
  const BANNER_ID = "sync-status-banner";
  const STYLE_ID = "sync-status-banner-style";

  function addCacheBust(url) {
    try {
      const parsed = new URL(url, window.location.href);
      if (!LEDGER_PATTERN.test(parsed.pathname)) {
        return url;
      }

      parsed.searchParams.set("_ts", Date.now().toString());
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function isLedgerUrl(url) {
    try {
      return LEDGER_PATTERN.test(new URL(url, window.location.href).pathname);
    } catch {
      return false;
    }
  }

  function patchFetch() {
    if (typeof window.fetch !== "function") {
      return;
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      let cacheSafeInit = init ? { ...init } : {};

      if (!cacheSafeInit.cache) {
        cacheSafeInit.cache = "no-store";
      }

      if (typeof input === "string") {
        return originalFetch(addCacheBust(input), cacheSafeInit);
      }

      if (input instanceof Request) {
        try {
          return originalFetch(new Request(addCacheBust(input.url), input), cacheSafeInit);
        } catch {
          return originalFetch(input, cacheSafeInit);
        }
      }

      return originalFetch(input, cacheSafeInit);
    };
  }

  function patchXhr() {
    if (typeof XMLHttpRequest === "undefined") {
      return;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      const nextUrl = typeof url === "string" ? addCacheBust(url) : url;
      this.__ledgerRequest = typeof url === "string" && isLedgerUrl(url);
      return originalOpen.call(this, method, nextUrl, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      if (this.__ledgerRequest) {
        try {
          this.setRequestHeader("Cache-Control", "no-cache");
          this.setRequestHeader("Pragma", "no-cache");
        } catch {
          // Ignore header errors in restricted browsers.
        }
      }

      return originalSend.call(this, body);
    };
  }

  function ensureBannerStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .sync-status-banner {
        max-width: 1150px;
        margin: 0 auto 20px;
        padding: 14px 18px;
        border: 1px solid rgba(255, 204, 0, 0.45);
        border-radius: 16px;
        background: linear-gradient(135deg, rgba(72, 40, 12, 0.92), rgba(52, 24, 14, 0.92));
        color: #fff4cc;
        box-shadow: 0 16px 30px rgba(0, 0, 0, 0.28);
        display: grid;
        gap: 10px;
      }

      .sync-status-banner strong {
        font-family: "Bebas Neue", Oswald, sans-serif;
        font-size: 1.15rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .sync-status-banner p {
        margin: 0;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }

      .sync-status-banner button {
        justify-self: start;
        border: none;
        border-radius: 999px;
        padding: 9px 14px;
        background: #ffcc00;
        color: #0b0e14;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }

      @media (max-width: 680px) {
        .sync-status-banner {
          margin-bottom: 16px;
        }
      }
    `;

    document.head.appendChild(style);
  }

  function formatTimestamp(value) {
    if (!value || value === "N/A") {
      return "okänd tid";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return new Intl.DateTimeFormat("sv-SE", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  function getBannerHost() {
    return document.querySelector("app-root") || document.body;
  }

  function removeBanner() {
    document.getElementById(BANNER_ID)?.remove();
  }

  function renderBanner(meta) {
    if (!meta || meta.lastRunStatus !== "FAIL") {
      removeBanner();
      return;
    }

    ensureBannerStyles();

    const host = getBannerHost();
    let banner = document.getElementById(BANNER_ID);
    if (!banner) {
      banner = document.createElement("section");
      banner.id = BANNER_ID;
      banner.className = "sync-status-banner";
      if (host === document.body) {
        host.prepend(banner);
      } else {
        host.parentNode?.insertBefore(banner, host);
      }
    }

    banner.replaceChildren();

    const title = document.createElement("strong");
    title.textContent = "Synk misslyckades";

    const body = document.createElement("p");
    body.textContent = `Visar senast tillgängliga data från ${formatTimestamp(meta.updatedAtUtc)}. ${meta.lastError || "Okänt fel i uppdateringen."}`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Ladda om sidan";
    button.addEventListener("click", () => {
      window.location.reload();
    });

    banner.append(title, body, button);
  }

  async function updateBanner() {
    try {
      const ledgerUrl = new URL("data/ledger.json", document.baseURI).toString();
      const response = await window.fetch(ledgerUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const ledger = await response.json();
      renderBanner(ledger?.meta ?? null);
    } catch {
      renderBanner({
        lastRunStatus: "FAIL",
        updatedAtUtc: "N/A",
        lastError: "Kunde inte läsa status för senaste uppdateringen."
      });
    }
  }

  patchFetch();
  patchXhr();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateBanner, { once: true });
  } else {
    updateBanner();
  }
})();
