import { Router, type Request, type Response } from "express";

const router = Router();

/**
 * Drop-in storefront analytics tracker for the Search & Discovery section.
 *
 * The storefront website (a separate codebase) includes this script with its
 * workspace API key and calls the helpers on user interactions:
 *
 *   <script
 *     src="https://os.presentail.com/api/web-events/tracker.js"
 *     data-api-key="pk_live_..."
 *     defer
 *   ></script>
 *
 *   PresentailAnalytics.trackSearch("red roses", 12);
 *
 * The script batches events and pushes them to POST /api/web-events using the
 * canonical event-type names the analytics backend recognizes (the first
 * synonym of each group in storeAnalytics.ts): search, search_no_result,
 * search_result_click, category_click, occasion_click, filter_selected,
 * sort_selected, recipient_selected, brand_selected, price_range_selected.
 *
 * Session/visitor ids, URL/path/referrer, UTM params, device type and
 * language are captured automatically and attached to every event.
 */
const TRACKER_JS = `(function () {
  "use strict";
  if (window.PresentailAnalytics) return;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    for (var i = s.length - 1; i >= 0; i--) {
      if ((s[i].src || "").indexOf("web-events/tracker.js") !== -1) return s[i];
    }
    return null;
  })();

  var apiKey = (script && script.getAttribute("data-api-key")) || "";
  var endpoint = (script && script.getAttribute("data-endpoint")) || null;
  if (!endpoint) {
    if (script && script.src) {
      endpoint = script.src.replace(/\\/web-events\\/tracker\\.js.*$/, "/web-events");
    } else {
      endpoint = "/api/web-events";
    }
  }

  function uid() {
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10)
    );
  }

  function safeStorage(store, key, gen) {
    try {
      var v = store.getItem(key);
      if (!v) {
        v = gen();
        store.setItem(key, v);
      }
      return v;
    } catch (e) {
      return gen();
    }
  }

  var SESSION_KEY = "pa_session_id";
  var VISITOR_KEY = "pa_visitor_id";
  var sessionId = safeStorage(window.sessionStorage, SESSION_KEY, uid);
  var visitorId = safeStorage(window.localStorage, VISITOR_KEY, uid);

  function deviceType() {
    var ua = navigator.userAgent || "";
    if (/tablet|ipad/i.test(ua)) return "tablet";
    if (/mobi|android|iphone/i.test(ua)) return "mobile";
    return "desktop";
  }

  function utm() {
    var out = {};
    try {
      var p = new URLSearchParams(window.location.search);
      var map = {
        utm_source: "utmSource",
        utm_medium: "utmMedium",
        utm_campaign: "utmCampaign",
        utm_term: "utmTerm",
        utm_content: "utmContent",
      };
      for (var k in map) {
        var v = p.get(k);
        if (v) out[map[k]] = v;
      }
    } catch (e) {}
    return out;
  }

  var queue = [];
  var flushTimer = null;
  var FLUSH_MS = 4000;
  var MAX_BATCH = 20;

  function send(events, useBeacon) {
    if (!events.length || !apiKey) return;
    var body = JSON.stringify({ events: events });
    var url = endpoint + "?apiKey=" + encodeURIComponent(apiKey);
    if (useBeacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(url, blob)) return;
      } catch (e) {}
    }
    try {
      fetch(endpoint, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: body,
      }).catch(function () {});
    } catch (e) {}
  }

  function flush(useBeacon) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    send(batch, useBeacon === true);
  }

  function track(type, fields) {
    if (!type) return;
    var base = utm();
    var e = {
      type: String(type),
      sessionId: sessionId,
      visitorId: visitorId,
      occurredAt: new Date().toISOString(),
      url: String(window.location.href).slice(0, 2000),
      path: String(window.location.pathname).slice(0, 2000),
      referrer: document.referrer ? String(document.referrer).slice(0, 2000) : null,
      deviceType: deviceType(),
      language: (navigator.language || "").slice(0, 20) || null,
    };
    for (var k in base) e[k] = base[k];
    if (fields) {
      for (var f in fields) {
        if (fields[f] !== undefined) e[f] = fields[f];
      }
    }
    queue.push(e);
    if (queue.length >= MAX_BATCH) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
    }
  }

  window.addEventListener("pagehide", function () {
    flush(true);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });

  window.PresentailAnalytics = {
    track: track,
    flush: flush,
    trackSearch: function (query, resultCount, extra) {
      var f = { searchQuery: query };
      if (typeof resultCount === "number") f.resultCount = resultCount;
      if (extra) for (var k in extra) f[k] = extra[k];
      track(typeof resultCount === "number" && resultCount === 0 ? "search_no_result" : "search", f);
    },
    trackSearchNoResult: function (query, extra) {
      var f = { searchQuery: query, resultCount: 0 };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("search_no_result", f);
    },
    trackSearchResultClick: function (query, productRef, extra) {
      var f = { searchQuery: query };
      if (productRef) f.productRef = String(productRef);
      if (extra) for (var k in extra) f[k] = extra[k];
      track("search_result_click", f);
    },
    trackCategoryClick: function (category, extra) {
      var f = { category: category };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("category_click", f);
    },
    trackOccasionClick: function (occasion, extra) {
      var f = { occasion: occasion };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("occasion_click", f);
    },
    trackFilterSelected: function (filterType, value, extra) {
      var f = { properties: { filterType: filterType, value: value } };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("filter_selected", f);
    },
    trackSortSelected: function (sortOption, extra) {
      var f = { properties: { sortOption: sortOption } };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("sort_selected", f);
    },
    trackRecipientSelected: function (recipient, extra) {
      var f = { properties: { recipient: recipient } };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("recipient_selected", f);
    },
    trackBrandSelected: function (brand, extra) {
      var f = { brand: brand };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("brand_selected", f);
    },
    trackPriceRangeSelected: function (min, max, extra) {
      var f = { properties: { priceMin: min, priceMax: max } };
      if (extra) for (var k in extra) f[k] = extra[k];
      track("price_range_selected", f);
    },
  };
})();
`;

/**
 * GET /api/web-events/tracker.js
 *
 * Public (no auth — the script contains no secrets; the storefront supplies
 * its own workspace API key via the data-api-key attribute). Cached for an
 * hour so repeat page loads are cheap.
 */
router.get("/web-events/tracker.js", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(TRACKER_JS);
});

export default router;
