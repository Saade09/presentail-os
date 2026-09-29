/**
 * SEO provider abstraction for the Backlink Engine.
 *
 * The active provider is selected by the SEO_PROVIDER env var:
 *   - "dataforseo" → DataForSeoProvider (production)
 *   - "stub" (default) → StubSeoProvider (development / testing)
 */

export interface BacklinkGapRow {
  domain: string;
  pageUrl: string;
  domainAuthority?: number;
  estimatedTraffic?: number;
  spamScore?: number;
  anchorText?: string;
  referringPage?: string;
  linksToCompetitor: string;
}

export interface CompetitorBacklinkRow {
  sourceUrl: string;
  destinationUrl: string;
  anchorText?: string;
  relType?: string;
  domainAuthority?: number;
  spamScore?: number;
}

export interface DomainMetrics {
  domain: string;
  domainAuthority?: number;
  estimatedTraffic?: number;
  spamScore?: number;
  referringDomains?: number;
}

export interface UnlinkedMentionRow {
  pageUrl: string;
  domain: string;
  snippet?: string;
  estimatedTraffic?: number;
}

export interface ISeoProvider {
  /** Returns all backlinks pointing to the given competitor domain. */
  getCompetitorBacklinks(domain: string): Promise<CompetitorBacklinkRow[]>;

  /**
   * Returns domains that link to one or more competitor domains but NOT to
   * the given target domain — the "backlink gap".
   * Uses /backlinks/referring-domains/live + /backlinks/summary/live.
   */
  getBacklinkGap(
    competitors: string[],
    targetDomain: string,
  ): Promise<BacklinkGapRow[]>;

  /** Returns pages that mention the brand/keywords but don't link to it. */
  getUnlinkedMentions(keywords: string[]): Promise<UnlinkedMentionRow[]>;

  /** Returns authority and traffic metrics for a list of domains. */
  getDomainMetrics(domains: string[]): Promise<DomainMetrics[]>;

  /**
   * Verifies whether a specific backlink from sourceUrl to targetDomain is
   * still present on the live page.
   *
   * Uses DataForSEO's On-Page API (/v3/on_page/instant_pages) to crawl the
   * source page and check its outgoing links in real time.
   *
   * Returns:
   *  - true  → page was crawled and contains a link to targetDomain
   *  - false → page was crawled but contains NO link to targetDomain
   *  - null  → page could not be crawled / API error (caller should fall back)
   *
   * Note: false means the link was absent in a fresh page crawl.
   * Callers may still perform an HTTP HEAD check to confirm the page itself
   * is reachable before finalizing a "lost" classification.
   */
  verifyLinkAlive(sourceUrl: string, targetDomain: string): Promise<boolean | null>;
}

// ─── DataForSEO provider ──────────────────────────────────────────────────────

class DataForSeoProvider implements ISeoProvider {
  private readonly login: string;
  private readonly password: string;
  private readonly baseUrl = "https://api.dataforseo.com/v3";

  constructor(login: string, password: string) {
    this.login = login;
    this.password = password;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.login}:${this.password}`).toString("base64");
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DataForSEO ${path} returned ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getCompetitorBacklinks(domain: string): Promise<CompetitorBacklinkRow[]> {
    try {
      type DfsResult = {
        tasks?: Array<{ result?: Array<{ items?: Array<Record<string, unknown>> }> }>;
      };
      const data = await this.post<DfsResult>("/backlinks/backlinks/live", [
        { target: domain, limit: 200, filters: [["dofollow", "=", true]] },
      ]);
      const items = data?.tasks?.[0]?.result?.[0]?.items ?? [];
      return items.map((item) => ({
        sourceUrl: String(item["url_from"] ?? ""),
        destinationUrl: String(item["url_to"] ?? ""),
        anchorText: item["anchor"] ? String(item["anchor"]) : undefined,
        relType: item["dofollow"] ? "follow" : "nofollow",
        domainAuthority:
          typeof item["domain_from_rank"] === "number" ? item["domain_from_rank"] : undefined,
        spamScore:
          typeof item["spam_score"] === "number" ? item["spam_score"] : undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fetches referring domains for a target via /backlinks/referring-domains/live.
   * Returns raw items from the DataForSEO response.
   */
  private async getReferringDomains(target: string, limit = 500): Promise<Array<Record<string, unknown>>> {
    try {
      type DfsResult = {
        tasks?: Array<{ result?: Array<{ items?: Array<Record<string, unknown>> }> }>;
      };
      const data = await this.post<DfsResult>("/backlinks/referring-domains/live", [
        {
          target,
          limit,
          order_by: ["rank,desc"],
        },
      ]);
      return data?.tasks?.[0]?.result?.[0]?.items ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Fetches authority and traffic summary for a single domain via
   * /backlinks/summary/live. Used to enrich gap domain metrics when
   * the referring-domains response lacks full stats.
   */
  async getDomainSummary(target: string): Promise<DomainMetrics | null> {
    try {
      type DfsResult = {
        tasks?: Array<{ result?: Array<Record<string, unknown>> }>;
      };
      const data = await this.post<DfsResult>("/backlinks/summary/live", [
        { target },
      ]);
      const item = data?.tasks?.[0]?.result?.[0];
      if (!item) return null;
      return {
        domain: target,
        domainAuthority: typeof item["rank"] === "number" ? item["rank"] : undefined,
        estimatedTraffic: typeof item["traffic"] === "number" ? item["traffic"] : undefined,
        spamScore:
          typeof item["spam_score"] === "number" ? item["spam_score"] : undefined,
        referringDomains:
          typeof item["referring_domains"] === "number" ? item["referring_domains"] : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Discovers backlink gap opportunities.
   *
   * Strategy:
   *  1. Fetch the target domain's referring-domain set via /backlinks/referring-domains/live.
   *  2. For each competitor, fetch their referring-domain set.
   *  3. Return domains that link to any competitor but NOT to us.
   *  4. For the top gap domains (up to 20), enrich with richer metrics via
   *     /backlinks/summary/live to surface referring_domains count and spam score.
   */
  async getBacklinkGap(
    competitors: string[],
    targetDomain: string,
  ): Promise<BacklinkGapRow[]> {
    if (competitors.length === 0) return [];
    try {
      // 1. Build our own referring-domain set for dedup
      const ourItems = await this.getReferringDomains(targetDomain, 1000);
      const ourDomains = new Set<string>(
        ourItems.map((item) => String(item["domain"] ?? "").replace(/^www\./, "").toLowerCase()),
      );

      const gaps: BacklinkGapRow[] = [];

      // 2. For each competitor, find domains NOT in our set
      for (const competitor of competitors) {
        const compItems = await this.getReferringDomains(competitor, 500);
        for (const item of compItems) {
          const rawDomain = String(item["domain"] ?? "");
          const normalizedDomain = rawDomain.replace(/^www\./, "").toLowerCase();
          if (!normalizedDomain || ourDomains.has(normalizedDomain)) continue;

          gaps.push({
            domain: rawDomain,
            pageUrl: item["url"] ? String(item["url"]) : `https://${rawDomain}`,
            domainAuthority: typeof item["rank"] === "number" ? item["rank"] : undefined,
            estimatedTraffic: typeof item["traffic"] === "number" ? item["traffic"] : undefined,
            spamScore: typeof item["spam_score"] === "number" ? item["spam_score"] : undefined,
            linksToCompetitor: competitor,
          });
        }
      }

      // 3. Enrich top gap domains with /backlinks/summary/live for richer authority data
      const TOP_N = 20;
      const topGaps = gaps.slice(0, TOP_N);
      await Promise.all(
        topGaps.map(async (gap, idx) => {
          const summary = await this.getDomainSummary(gap.domain);
          if (!summary) return;
          gaps[idx] = {
            ...gap,
            domainAuthority: summary.domainAuthority ?? gap.domainAuthority,
            estimatedTraffic: summary.estimatedTraffic ?? gap.estimatedTraffic,
            spamScore: summary.spamScore ?? gap.spamScore,
          };
        }),
      );

      return gaps;
    } catch {
      return [];
    }
  }

  async getUnlinkedMentions(keywords: string[]): Promise<UnlinkedMentionRow[]> {
    if (keywords.length === 0) return [];
    try {
      type DfsResult = {
        tasks?: Array<{ result?: Array<{ items?: Array<Record<string, unknown>> }> }>;
      };
      const data = await this.post<DfsResult>("/serp/google/organic/live/advanced", [
        { keyword: keywords[0], location_code: 971, language_code: "en", limit: 50 },
      ]);
      const items = data?.tasks?.[0]?.result?.[0]?.items ?? [];
      return items.map((item) => ({
        pageUrl: String(item["url"] ?? ""),
        domain: String(item["domain"] ?? ""),
        snippet: item["description"] ? String(item["description"]) : undefined,
      }));
    } catch {
      return [];
    }
  }

  async getDomainMetrics(domains: string[]): Promise<DomainMetrics[]> {
    if (domains.length === 0) return [];

    // For single-domain lookups, use /backlinks/summary/live for comprehensive data
    if (domains.length === 1) {
      const summary = await this.getDomainSummary(domains[0]);
      return summary ? [summary] : [];
    }

    // For bulk lookups, use /backlinks/bulk_ranks/live
    try {
      type DfsResult = {
        tasks?: Array<{ result?: Array<Record<string, unknown>> }>;
      };
      const data = await this.post<DfsResult>("/backlinks/bulk_ranks/live", [
        { targets: domains.slice(0, 100) },
      ]);
      const items = data?.tasks?.[0]?.result ?? [];
      return items.map((item) => ({
        domain: String(item["target"] ?? ""),
        domainAuthority: typeof item["rank"] === "number" ? item["rank"] : undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Verifies whether a specific backlink is still live using DataForSEO's
   * On-Page API — /v3/on_page/instant_pages.
   *
   * Crawls the source page in real time and checks whether any of its outgoing
   * links point to the target domain. This is a page-level truth check (not
   * an index snapshot), making it suitable for the link monitor job.
   *
   * Returns:
   *  - true  → page crawled; at least one outgoing link points to targetDomain
   *  - false → page crawled successfully; no link found to targetDomain
   *  - null  → page could not be crawled (bad status, empty result, API error)
   *            — caller should fall back to HTTP HEAD
   */
  async verifyLinkAlive(sourceUrl: string, targetDomain: string): Promise<boolean | null> {
    try {
      type OnPageLink = { href?: string; url?: string };
      type OnPageItem = {
        meta?: { links?: OnPageLink[]; external_links?: OnPageLink[] };
      };
      type DfsResult = {
        tasks?: Array<{
          status_code?: number;
          result?: Array<{
            crawl_progress?: string;
            items_count?: number;
            items?: OnPageItem[];
          }>;
        }>;
      };

      const data = await this.post<DfsResult>("/on_page/instant_pages", [
        {
          url: sourceUrl,
          load_resources: false,
          check_spell: false,
          disable_cookie_popup: true,
          store_raw_html: false,
        },
      ]);

      const task = data?.tasks?.[0];
      if (!task || (task.status_code !== undefined && task.status_code !== 20000)) {
        return null;
      }

      const result = task.result?.[0];
      if (!result || result.crawl_progress === "in_queue") return null;

      const items = result.items ?? [];
      if (items.length === 0) return null;

      const allLinks: OnPageLink[] = [
        ...(items[0]?.meta?.links ?? []),
        ...(items[0]?.meta?.external_links ?? []),
      ];

      if (allLinks.length === 0) {
        // Crawl succeeded but no links returned — treat as uncertain rather than false
        return null;
      }

      const normalizedTarget = targetDomain.replace(/^www\./, "").toLowerCase();
      const hasLink = allLinks.some((link) => {
        const href = (link.href ?? link.url ?? "").toLowerCase();
        return href.includes(normalizedTarget);
      });

      return hasLink;
    } catch {
      return null;
    }
  }
}

// ─── Stub provider ────────────────────────────────────────────────────────────

class StubSeoProvider implements ISeoProvider {
  async getCompetitorBacklinks(_domain: string): Promise<CompetitorBacklinkRow[]> {
    return [
      {
        sourceUrl: "https://example.com/page",
        destinationUrl: "https://competitor.com",
        anchorText: "great flowers",
        relType: "follow",
        domainAuthority: 45,
        spamScore: 3,
      },
    ];
  }

  async getBacklinkGap(
    _competitors: string[],
    _targetDomain: string,
  ): Promise<BacklinkGapRow[]> {
    return [
      {
        domain: "floralblog.com",
        pageUrl: "https://floralblog.com/top-florists-uae",
        domainAuthority: 38,
        estimatedTraffic: 5000,
        spamScore: 1,
        linksToCompetitor: _competitors[0] ?? "competitor.com",
      },
    ];
  }

  async getUnlinkedMentions(_keywords: string[]): Promise<UnlinkedMentionRow[]> {
    return [
      {
        pageUrl: "https://blog.example.com/best-florists",
        domain: "blog.example.com",
        snippet: "Presentail is one of the best flower delivery services in UAE",
        estimatedTraffic: 1200,
      },
    ];
  }

  async getDomainMetrics(domains: string[]): Promise<DomainMetrics[]> {
    return domains.map((d) => ({ domain: d, domainAuthority: 30, estimatedTraffic: 1000, spamScore: 2 }));
  }

  async verifyLinkAlive(_sourceUrl: string, _targetDomain: string): Promise<boolean | null> {
    return null;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let _instance: ISeoProvider | null = null;

export function getSeoProvider(): ISeoProvider {
  if (_instance) return _instance;
  const provider = process.env.SEO_PROVIDER ?? "stub";
  if (provider === "dataforseo") {
    const login = process.env.DATAFORSEO_LOGIN ?? "";
    const password = process.env.DATAFORSEO_PASSWORD ?? "";
    _instance = new DataForSeoProvider(login, password);
  } else {
    _instance = new StubSeoProvider();
  }
  return _instance;
}

/** Reset the cached instance (for testing). */
export function resetSeoProviderInstance(): void {
  _instance = null;
}

/**
 * Returns the current SEO provider status for display on the settings page.
 * Reads environment variables at call time (not cached).
 */
export function getSeoProviderStatus(): {
  provider: string;
  configured: boolean;
  live: boolean;
} {
  const provider = process.env.SEO_PROVIDER ?? "stub";
  const isDataForSeo = provider === "dataforseo";
  const hasCredentials =
    isDataForSeo &&
    !!process.env.DATAFORSEO_LOGIN &&
    !!process.env.DATAFORSEO_PASSWORD;
  return {
    provider,
    configured: !isDataForSeo || hasCredentials,
    live: hasCredentials,
  };
}
