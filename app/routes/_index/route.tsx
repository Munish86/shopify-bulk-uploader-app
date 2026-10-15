import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

// Public landing page. App Store requirement 2.3.1: an app must not ask merchants to type their
// myshopify.com domain, so there is no login form here; installs start from the App Store (or the
// CLI install link during development) and come back here with ?shop=.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Bulk Product Uploader</h1>
        <p className={styles.text}>
          Update or create hundreds of Shopify products at once from a spreadsheet and a folder of images.
        </p>
        <p className={styles.text}>Install it from the Shopify App Store, then open it from your Shopify admin.</p>
        <ul className={styles.list}>
          <li>
            <strong>Any sheet</strong>. Excel, CSV or Google Sheets, with your
            own column names.
          </li>
          <li>
            <strong>Images by file name</strong>. Upload a folder or link Google
            Drive; images are matched to products automatically.
          </li>
          <li>
            <strong>Preview first</strong>. See every change before anything is
            saved, with backups of each product.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy policy</a> · <a href="/support">Support</a>
        </p>
      </div>
    </div>
  );
}
