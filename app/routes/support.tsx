// Public support page (linked from the App Store listing). Plain HTML, no login.
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

export const meta: MetaFunction = () => [{ title: "Support · Bulk Product Uploader" }];

export const loader = async () => ({
  // eslint-disable-next-line no-undef
  email: process.env.SUPPORT_EMAIL || "support@example.com",
});

export default function Support() {
  const { email } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", font: "16px/1.6 system-ui, sans-serif" }}>
      <h1>Support</h1>
      <p>
        Email <a href={`mailto:${email}`}>{email}</a>. Include your store address (xxxx.myshopify.com) and, if a run went
        wrong, the time of the run.
      </p>
      <h2>Common questions</h2>
      <h3>An upload changed the wrong thing. Can I undo it?</h3>
      <p>
        Yes. Open the app, go to Backups, choose the upload, click &quot;Preview restore&quot;, then &quot;Restore&quot;. Only
        what that upload changed is put back. A restore can be undone the same way.
      </p>
      <h3>&quot;Not found in Shopify&quot;</h3>
      <p>No product has that SKU, handle or title. Check the &quot;Find each product&quot; rules, or turn on &quot;Create products that are not in Shopify&quot;.</p>
      <h3>My Google Sheet or Drive folder cannot be read</h3>
      <p>Share it with the email shown in the app as &quot;Viewer&quot;, or set it to &quot;Anyone with the link can view&quot;.</p>
      <h3>&quot;Plan limit reached&quot;</h3>
      <p>Your plan&apos;s products for this month are used up. Upgrade on the Plans page, or wait until the 1st of next month. Check and preview are always free.</p>
      <p>
        <a href="/privacy">Privacy policy</a>
      </p>
    </main>
  );
}
