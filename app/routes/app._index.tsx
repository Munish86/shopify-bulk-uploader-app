import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getGoogle } from "../.server/clients";
import { getSettings } from "../.server/shops";
import { listJobs } from "../.server/jobs/service";
import { Uploader } from "../components/uploader/Uploader";
import type { JobInfo } from "../components/uploader/api";

// Permissions the uploader needs. write_* includes read access.
const NEEDED_SCOPES = ["write_products", "write_files"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const response = await admin.graphql(
    `#graphql
    query uploaderHome {
      shop { name }
      currentAppInstallation { accessScopes { handle } }
    }`,
  );
  const { data } = await response.json();
  const granted = data?.currentAppInstallation?.accessScopes.map((s: { handle: string }) => s.handle) ?? [];

  await prisma.shop.upsert({
    where: { shop },
    create: { shop, name: data?.shop?.name ?? "" },
    update: { name: data?.shop?.name ?? "" },
  });
  const [settings, imageCount, jobs] = await Promise.all([
    getSettings(shop),
    prisma.storedFile.count({ where: { shop, kind: "image" } }),
    listJobs(shop, 1),
  ]);

  return {
    shopName: data?.shop?.name || shop,
    missingScopes: NEEDED_SCOPES.filter((s) => !granted.includes(s)),
    settings,
    imageCount,
    latestJob: (jobs[0] ?? null) as unknown as JobInfo | null,
    googleEmail: getGoogle().email,
  };
};

export default function Index() {
  const d = useLoaderData<typeof loader>();

  return (
    <s-page heading="Bulk Product Uploader">
      {d.missingScopes.length > 0 && (
        <s-banner tone="critical" heading="Permissions missing">
          The app is missing these permissions: {d.missingScopes.join(", ")}. Open the app again from Shopify Admin
          to approve them.
        </s-banner>
      )}
      <s-paragraph>
        Update or create products in {d.shopName} from a sheet and a folder of images. Work down the page: add the
        sheet, map its columns, add images, then check, preview and upload.
      </s-paragraph>
      <Uploader
        initialSettings={d.settings}
        imageCount={d.imageCount}
        googleEmail={d.googleEmail}
        latestJob={d.latestJob}
        templateUrl="/templates/Shopify-Product-Template.xlsx"
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
