// Public privacy policy page (linked from the App Store listing). Plain HTML, no login.
// The owner must review this text before launch; it describes what the code stores and for how long.
import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { BACKUP_KEEP_MONTHS } from "../lib/plans";

export const meta: MetaFunction = () => [{ title: "Privacy policy · Bulk Product Uploader" }];

export const loader = async () => ({
  // eslint-disable-next-line no-undef
  email: process.env.SUPPORT_EMAIL || "support@example.com",
  // eslint-disable-next-line no-undef
  fileDays: Number(process.env.FILE_RETENTION_DAYS || 7),
});

export default function Privacy() {
  const { email, fileDays } = useLoaderData<typeof loader>();
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", font: "16px/1.6 system-ui, sans-serif" }}>
      <h1>Privacy policy</h1>
      <p>
        Bulk Product Uploader (&quot;the app&quot;) helps Shopify merchants create and update products from a sheet and
        images. This page explains what the app stores, why, and for how long.
      </p>
      <h2>What the app stores</h2>
      <ul>
        <li>Your store&apos;s address and name, the plan you are on, and the access token Shopify gives the app when you install it.</li>
        <li>Your settings: column mapping, update rules and the links you enter (Google Sheet, Google Drive folder).</li>
        <li>Sheets and images you upload. They are deleted automatically after {fileDays} days.</li>
        <li>
          A backup of each product before the app changes it, so you can undo an upload. Backups are deleted automatically
          after {BACKUP_KEEP_MONTHS} months.
        </li>
        <li>Run history: reports and logs of image checks, previews, uploads and restores, kept for {BACKUP_KEEP_MONTHS} months.</li>
        <li>The number of products the app created or updated each month, for your plan&apos;s limit.</li>
      </ul>
      <h2>What the app does not store</h2>
      <p>
        The app does not ask Shopify for customer or order data and does not store any. It only reads and changes products,
        collections, metafields and product images.
      </p>
      <h2>Google Sheets and Google Drive</h2>
      <p>
        If you use a Google Sheet or a Drive folder, the app reads only the files you share with its service account (or
        that you made public with a link), and only when you start a run.
      </p>
      <h2>Where the data is kept</h2>
      <p>
        On the app&apos;s servers and its file storage, used only to run the app. The data is not sold or shared with anyone
        else. Payments are handled by Shopify; the app never sees card details.
      </p>
      <p>
        The app runs on these service providers, which process the data only on the app&apos;s behalf: Railway (servers and
        database), Cloudflare R2 (uploaded files and reports) and, if you use a Google Sheet or Drive folder, Google.
      </p>
      <h2>Deleting your data</h2>
      <p>
        When you uninstall the app, it stops all runs at once. Shopify then asks the app to delete your store&apos;s data,
        and the app deletes all of it: settings, files, backups, reports and usage. You can also ask for deletion at any time
        by email.
      </p>
      <h2>Contact</h2>
      <p>
        Questions or requests: <a href={`mailto:${email}`}>{email}</a>
      </p>
    </main>
  );
}
