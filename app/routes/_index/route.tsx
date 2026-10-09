import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Bulk Product Uploader</h1>
        <p className={styles.text}>
          Update or create hundreds of Shopify products at once from a spreadsheet and a folder of images.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
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
      </div>
    </div>
  );
}
