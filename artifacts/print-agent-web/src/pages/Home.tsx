import React from "react";
import { Link } from "wouter";
import {
  Terminal,
  CheckCircle2,
  Command,
  Monitor,
  BarChart3,
  ShieldCheck,
  Tag,
  Users,
  ScrollText,
  MapPin,
  Download,
  ArrowRight,
  Wifi,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const TRUST_POINTS = [
  { icon: <Tag size={16} />, label: "Brand management" },
  { icon: <Wifi size={16} />, label: "Real-time operations" },
  { icon: <MapPin size={16} />, label: "Multi-location ready" },
  { icon: <Users size={16} />, label: "Team-ready" },
  { icon: <ShieldCheck size={16} />, label: "Role-based access" },
  { icon: <Layers size={16} />, label: "Product control" },
];

const FEATURES = [
  {
    icon: <BarChart3 size={22} />,
    color: "bg-blue-500/10 text-blue-600",
    title: "Analytics & Operational Insights",
    description:
      "Track activity, job volumes, and trends across the entire platform. Understand performance, spot bottlenecks, and make informed decisions across every location.",
  },
  {
    icon: <Monitor size={22} />,
    color: "bg-green-500/10 text-green-600",
    title: "Device & Agent Monitoring",
    description:
      "See every connected device and agent in real time. Know instantly which agents are online, idle, or unreachable — no guesswork.",
  },
  {
    icon: <Tag size={22} />,
    color: "bg-purple-500/10 text-purple-600",
    title: "Brand & Product Management",
    description:
      "Manage brands, upload sticker templates, and control exactly which products and designs are available to which teams and locations.",
  },
  {
    icon: <Users size={22} />,
    color: "bg-orange-500/10 text-orange-600",
    title: "Team Roles & Permissions",
    description:
      "Grant precise access with custom roles. Control who can view, manage, or administer every section of the platform.",
  },
  {
    icon: <ScrollText size={22} />,
    color: "bg-rose-500/10 text-rose-600",
    title: "History & Audit Log",
    description:
      "Every action is logged with timestamps, actor, and outcome. Full audit trail across jobs, members, and settings — so nothing slips through the cracks.",
  },
];

export default function Home() {
  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground flex flex-col items-center">

      {/* ── Header ─────────────────────────────────────── */}
      <header className="w-full max-w-6xl mx-auto px-6 py-6 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <img
            src="/presentail-logo.png"
            aria-hidden="true"
            className="w-9 h-9 rounded-md object-cover"
          />
          <span className="font-bold text-lg tracking-tight">Presentail OS</span>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="https://presentail.com" target="_blank" rel="noopener noreferrer">
              presentail.com
            </a>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex" data-testid="link-api-docs">
            <Link href="/api-docs">
              API Docs
            </Link>
          </Button>
          <Button asChild size="sm" data-testid="link-sign-in">
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────── */}
      <main className="w-full max-w-6xl mx-auto px-6 pt-12 pb-20 md:pt-20 md:pb-28 flex flex-col items-center text-center gap-8">
        <div
          data-testid="text-hero-badge"
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold uppercase tracking-wider"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          All-in-one operations platform
        </div>

        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-tight max-w-3xl">
          Your entire operation,{" "}
          <span className="text-primary">under control</span>
        </h1>

        <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
          Presentail OS brings your brands, products, stickers, locations,
          teams, analytics, and print together in one unified platform — with
          real-time visibility and granular access control built in.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <Button
            asChild
            size="lg"
            className="h-12 px-7 text-base font-medium gap-2"
            data-testid="link-sign-in-hero"
          >
            <Link href="/sign-in">
              Sign in
              <ArrowRight size={18} />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="lg"
            className="h-12 px-7 text-base font-medium gap-2"
            data-testid="button-download-mac"
          >
            <a href="/api/download/mac" download="PrintAgent.zip">
              <Download size={18} />
              Download agent
            </a>
          </Button>
        </div>

        {/* Terminal mockup */}
        <div className="w-full max-w-2xl mt-6 relative">
          <div className="absolute inset-0 bg-primary/10 blur-3xl rounded-full" />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col text-left">
            <div className="h-10 border-b border-border bg-muted/40 flex items-center px-4 gap-2">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-destructive/70" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/70" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/70" />
              </div>
              <span className="ml-3 text-xs font-mono text-muted-foreground">print-agent — server</span>
            </div>
            <div className="p-5 font-mono text-sm leading-relaxed bg-zinc-950 text-zinc-300">
              <div className="text-green-400">$ ./print-agent start</div>
              <div className="text-zinc-500">[INFO] Starting Print Agent v1.0.0...</div>
              <div className="text-zinc-500">[INFO] Discovered 3 local printers</div>
              <div className="text-cyan-400">[READY] Server listening on http://localhost:8080</div>
              <div className="mt-3 text-zinc-500">Waiting for print jobs...</div>
              <div className="mt-1.5 text-primary">POST /api/print 200 OK</div>
              <div className="text-zinc-500">→ Sending invoice.pdf to "Office_Laser"</div>
            </div>
          </div>
        </div>
      </main>

      {/* ── Trust bar ──────────────────────────────────── */}
      <section className="w-full border-y border-border bg-secondary/40 py-5">
        <div className="w-full max-w-6xl mx-auto px-6">
          <ul className="flex flex-wrap justify-center gap-x-8 gap-y-3">
            {TRUST_POINTS.map(({ icon, label }) => (
              <li key={label} className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
                <span className="text-primary">{icon}</span>
                {label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Feature highlights ─────────────────────────── */}
      <section className="w-full max-w-6xl mx-auto px-6 py-24">
        <div className="text-center mb-14">
          <h2 className="text-3xl font-bold tracking-tight mb-4">
            Everything your team needs to run the operation
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto text-lg">
            One platform for every corner of your operation — brands, products,
            locations, people, and print, all in one place.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map(({ icon, color, title, description }) => (
            <div
              key={title}
              className="bg-card border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-4"
            >
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
                {icon}
              </div>
              <div>
                <h3 className="font-semibold text-base mb-1.5">{title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
              </div>
            </div>
          ))}

          {/* Locations card spanning remaining space on last row */}
          <div className="bg-card border border-border rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-4 sm:col-span-2 lg:col-span-1">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-teal-500/10 text-teal-600">
              <MapPin size={22} />
            </div>
            <div>
              <h3 className="font-semibold text-base mb-1.5">Multi-Location Management</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Group devices and users by physical location. Manage your full operation across offices, warehouses, or retail sites — all from one dashboard.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────── */}
      <section className="w-full border-t border-border bg-secondary/30 py-24">
        <div className="w-full max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-bold tracking-tight mb-4">
              Up and running in minutes
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto text-lg">
              Install the lightweight background agent, connect it to your
              workspace, and you're ready to manage print jobs from anywhere.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-14">
            {/* Step 1 */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground font-bold text-sm flex items-center justify-center flex-shrink-0">
                  1
                </div>
                <h3 className="font-semibold text-base">Download &amp; install the agent</h3>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed pl-12">
                Grab the agent for Mac or Windows. It runs silently in the
                background and requires no dependencies or runtime.
              </p>
              <div className="pl-12 flex flex-col sm:flex-row md:flex-col gap-2">
                <Button
                  asChild
                  size="sm"
                  className="gap-2 w-fit"
                  data-testid="button-download-mac"
                >
                  <a href="/api/download/mac" download="PrintAgent.zip">
                    <Command size={15} />
                    Download for Mac
                  </a>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="gap-2 w-fit"
                  data-testid="button-download-windows"
                >
                  <a href="/api/download/windows" download="PrintAgent-Windows.zip">
                    <Monitor size={15} />
                    Download for Windows
                  </a>
                </Button>
              </div>

              {/* Mac install details */}
              <details
                className="pl-12 text-sm text-muted-foreground group"
                data-testid="install-help-mac"
              >
                <summary className="cursor-pointer hover:text-foreground transition-colors flex items-center gap-1.5 select-none">
                  <Terminal size={13} />
                  <span>Mac install help (3 steps)</span>
                </summary>
                <div className="mt-3 p-4 bg-card border border-border rounded-lg space-y-3 text-foreground">
                  <ol className="list-decimal pl-5 space-y-2 text-sm">
                    <li>
                      Double-click{" "}
                      <code className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        PrintAgent.zip
                      </code>{" "}
                      in your Downloads folder to unzip it. You'll get a{" "}
                      <code className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        PrintAgent
                      </code>{" "}
                      folder.
                    </li>
                    <li>
                      Open the folder, then{" "}
                      <strong>right-click</strong> (or Control-click){" "}
                      <code className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        Install.command
                      </code>{" "}
                      and choose <strong>Open</strong>.
                    </li>
                    <li>
                      In the macOS warning dialog, click{" "}
                      <strong>Open</strong> again to confirm. A Terminal window
                      will open, install the agent, and your browser will open
                      to the Connect page automatically.
                    </li>
                  </ol>
                  <p className="text-xs text-muted-foreground pt-2">
                    You only need to do the right-click step the first time. To
                    remove the agent later, double-click{" "}
                    <code className="px-1 py-0.5 bg-muted rounded">
                      Uninstall.command
                    </code>{" "}
                    in the same folder.
                  </p>
                </div>
              </details>

              {/* Windows install details */}
              <details
                className="pl-12 text-sm text-muted-foreground group"
                data-testid="install-help-windows"
              >
                <summary className="cursor-pointer hover:text-foreground transition-colors flex items-center gap-1.5 select-none">
                  <Terminal size={13} />
                  <span>Windows protected your PC? Click here</span>
                </summary>
                <div className="mt-3 p-4 bg-card border border-border rounded-lg space-y-3 text-foreground">
                  <p className="text-sm">
                    Windows SmartScreen warns about apps it hasn't seen before.
                    To install Presentail OS:
                  </p>
                  <ol className="list-decimal pl-5 space-y-2 text-sm">
                    <li>
                      Extract the downloaded{" "}
                      <code className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        PrintAgent-Windows.zip
                      </code>{" "}
                      by right-clicking it and choosing{" "}
                      <strong>Extract All…</strong>
                    </li>
                    <li>
                      Open the extracted folder and double-click{" "}
                      <code className="px-1.5 py-0.5 bg-muted rounded text-xs">
                        install.bat
                      </code>
                    </li>
                    <li>
                      If you see a blue{" "}
                      <strong>"Windows protected your PC"</strong> dialog, click{" "}
                      <strong>More info</strong> → then click{" "}
                      <strong>Run anyway</strong>
                    </li>
                    <li>
                      If Windows asks for administrator permission, click{" "}
                      <strong>Yes</strong>
                    </li>
                  </ol>
                </div>
              </details>
            </div>

            {/* Step 2 */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground font-bold text-sm flex items-center justify-center flex-shrink-0">
                  2
                </div>
                <h3 className="font-semibold text-base">Connect your workspace</h3>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed pl-12">
                After installation the agent opens the Connect page in your
                browser. Sign in and your device is linked to your workspace
                instantly — printers appear on the dashboard in seconds.
              </p>
            </div>

            {/* Step 3 */}
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground font-bold text-sm flex items-center justify-center flex-shrink-0">
                  3
                </div>
                <h3 className="font-semibold text-base">Manage your full operation</h3>
              </div>
              <p className="text-muted-foreground text-sm leading-relaxed pl-12">
                Manage brands, products, locations, and teams — then send print
                jobs via the dashboard or API, monitor queues in real time, and
                review the full audit trail, all from one place.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Closing CTA ────────────────────────────────── */}
      <section className="w-full bg-primary/5 border-t border-primary/10 py-24">
        <div className="w-full max-w-6xl mx-auto px-6 flex flex-col items-center text-center gap-6">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight max-w-xl">
            Ready to run your entire operation from one place?
          </h2>
          <p className="text-muted-foreground text-lg max-w-lg">
            Join teams already using Presentail OS to manage brands, products,
            locations, people, and print — from anywhere.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <Button
              asChild
              size="lg"
              className="h-12 px-8 text-base font-medium gap-2"
              data-testid="link-sign-in-cta"
            >
              <Link href="/sign-in">
                Sign in
                <ArrowRight size={18} />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              size="lg"
              className="h-12 px-8 text-base font-medium gap-2"
            >
              <a href="/api/download/mac" download="PrintAgent.zip">
                <Command size={18} />
                Download for Mac
              </a>
            </Button>
            <Button
              asChild
              variant="outline"
              size="lg"
              className="h-12 px-8 text-base font-medium gap-2"
            >
              <a href="/api/download/windows" download="PrintAgent-Windows.zip">
                <Monitor size={18} />
                Download for Windows
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────── */}
      <footer className="w-full py-10 border-t border-border">
        <div className="w-full max-w-6xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <img
              src="/presentail-logo.png"
              aria-hidden="true"
              className="w-6 h-6 rounded object-cover"
            />
            <span className="font-medium text-foreground">Presentail OS</span>
            <span className="hidden sm:inline">— The all-in-one operations platform for Presentail.</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://presentail.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              presentail.com
            </a>
            <Link
              href="/api-docs"
              className="hover:text-foreground transition-colors"
              data-testid="link-api-docs-footer"
            >
              API Docs
            </Link>
            <Link href="/sign-in" className="hover:text-foreground transition-colors" data-testid="link-sign-in-footer">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
