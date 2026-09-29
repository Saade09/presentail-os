import { Link } from "wouter";
import { GitPullRequest, ShoppingBag } from "lucide-react";

export default function CmcPosSecondaryWorkflows() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {/* New Order */}
      <Link href="/cmc-pos/new-order" asChild>
        <a
          data-testid="btn-create-new-order"
          className="group flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md active:shadow-none"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-100 transition-colors group-hover:bg-teal-200">
            <ShoppingBag className="h-5 w-5 text-teal-700" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">New order</p>
            <p className="text-xs text-gray-500 truncate">
              Custom order with delivery
            </p>
          </div>
        </a>
      </Link>

      {/* Branch Request */}
      <Link href="/cmc-pos/request" asChild>
        <a
          data-testid="btn-create-request"
          className="group flex items-center gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md active:shadow-none"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 transition-colors group-hover:bg-blue-200">
            <GitPullRequest className="h-5 w-5 text-blue-700" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">Request From Branch</p>
            <p className="text-xs text-gray-500 truncate">
              Dispatch products from another branch
            </p>
          </div>
        </a>
      </Link>

    </div>
  );
}
