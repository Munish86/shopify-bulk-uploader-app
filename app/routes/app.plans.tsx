// Plans: the current plan, this month's usage, and the plans on offer. Choosing or changing a plan happens
// on Shopify's own plan page (Managed Pricing), where prices and the free trial are set in the Partner Dashboard.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { appHandle, syncPlan } from "../.server/shops";
import { usageThisMonth } from "../.server/run-store";
import { BACKUP_KEEP_MONTHS, PLANS, planByKey, remaining } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const planKey = await syncPlan(session.shop, (q) => admin.graphql(q));
  const used = await usageThisMonth(session.shop);
  const plan = planByKey(planKey);
  const store = session.shop.replace(".myshopify.com", "");
  const handle = appHandle();
  return {
    current: plan.key,
    used,
    limit: plan.productsPerMonth,
    remaining: remaining(plan, used),
    pricingUrl: `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`,
  };
};

export default function PlansPage() {
  const d = useLoaderData<typeof loader>();
  const current = planByKey(d.current);
  const resetsOn = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });

  return (
    <s-page heading="Plans">
      <s-section heading="Your plan">
        <s-stack direction="block" gap="small-200">
          <s-text>
            <strong>{current.name}</strong>
            {d.limit == null
              ? ` · no monthly limit · ${d.used} products created or updated this month`
              : ` · ${d.used} of ${d.limit} products used this month · ${d.remaining} left · resets on ${resetsOn}`}
          </s-text>
          <s-text color="subdued">
            Only products actually created or updated count. Image check, preview and restoring a backup are always free.
            Backups are kept for {BACKUP_KEEP_MONTHS} months on every plan.
          </s-text>
          <div>
            <s-button variant="primary" href={d.pricingUrl} target="_top">
              {current.key === "free" ? "Upgrade" : "Change plan"}
            </s-button>
          </div>
        </s-stack>
      </s-section>
      <s-section heading="All plans">
        <s-grid gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="base">
          {PLANS.map((p) => (
            <s-box key={p.key} padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small-200">
                <s-heading>
                  {p.name}
                  {p.key === current.key ? " (your plan)" : ""}
                </s-heading>
                <s-unordered-list>
                  {p.features.map((f) => (
                    <s-list-item key={f}>{f}</s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            </s-box>
          ))}
        </s-grid>
        <s-text color="subdued">Prices and the free trial are shown on Shopify&apos;s plan page, and charged on your Shopify bill.</s-text>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
