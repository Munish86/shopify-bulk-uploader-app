/* eslint-disable @typescript-eslint/no-explicit-any -- raw Admin API JSON, shaped by each query */
// Shopify Admin GraphQL calls used by the uploader, with retries and rate-limit handling.
import type { MetafieldInput, ProductSetInput } from "./build";
import { norm, sleep } from "./util";

const PRODUCT_FIELDS = `
  id handle title status tags vendor productType descriptionHtml
  seo { title description }
  options { name optionValues { name } }
  variants(first: 250) { nodes { id sku price compareAtPrice barcode selectedOptions { name value } } }
  media(first: 250) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
  collections(first: 250) { nodes { id title ruleSet { appliedDisjunctively } } }
`;

export interface ShopifyProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  tags: string[];
  vendor: string;
  productType: string;
  descriptionHtml: string;
  seo: { title: string | null; description: string | null } | null;
  options: { name: string; optionValues: { name: string }[] }[];
  variants: {
    id: string;
    sku: string | null;
    price: string;
    compareAtPrice: string | null;
    barcode: string | null;
    selectedOptions: { name: string; value: string }[];
  }[];
  media: { id: string; alt: string | null; mediaContentType: string; image?: { url: string } | null }[];
  collections: { id: string; title: string; ruleSet: unknown }[];
}

export interface Collection {
  id: string;
  title: string;
  handle: string;
  smart: boolean;
}

export type FindResult = { product: ShopifyProduct | null; ambiguous?: undefined } | { ambiguous: string; product?: undefined };

class GraphqlError extends Error {
  constructor(
    message: string,
    public graphqlErrors: { message: string; extensions?: { code?: string } }[],
  ) {
    super(message);
  }
}

// Quotes a value for Shopify's search syntax
const q = (v: string) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function flatten(p: any): ShopifyProduct | null {
  if (!p) return null;
  return {
    ...p,
    variants: p.variants?.nodes || [],
    media: p.media?.nodes || [],
    collections: p.collections?.nodes || [],
    options: p.options || [],
  };
}

export interface ShopifyClientOptions {
  shop: string; // "my-store.myshopify.com"
  apiVersion: string;
  // Returns a valid offline access token. Called again with refresh = true after a 401.
  accessToken: (refresh?: boolean) => Promise<string>;
  endpoint?: string; // tests point this at a simulated store
}

export class Shopify {
  readonly shop: string;
  private endpoint: string;
  private getToken: ShopifyClientOptions["accessToken"];
  adminBase: string;

  constructor(opts: ShopifyClientOptions) {
    this.shop = opts.shop;
    this.getToken = opts.accessToken;
    this.endpoint = opts.endpoint || `https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`;
    this.adminBase = `https://admin.shopify.com/store/${opts.shop.replace(".myshopify.com", "")}`;
  }

  async shopInfo(): Promise<{ name: string; myshopifyDomain: string; currencyCode: string }> {
    const d = await this.gql(`{ shop { name myshopifyDomain currencyCode } }`);
    return d.shop;
  }

  // Which permissions the app has. Returns null if Shopify does not say.
  async scopes(): Promise<string[] | null> {
    try {
      const d = await this.gql("{ currentAppInstallation { accessScopes { handle } } }");
      return d.currentAppInstallation.accessScopes.map((s: { handle: string }) => s.handle);
    } catch {
      return null;
    }
  }

  adminUrl(gid?: string | null): string {
    return gid ? `${this.adminBase}/products/${String(gid).split("/").pop()}` : "";
  }

  async gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-shopify-access-token": await this.getToken(),
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        if (attempt < 5) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw e;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !refreshed) {
        // The offline token may have expired during a long run: get a fresh one and try again
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Shopify refused the request (${res.status}). The app may have been uninstalled, or is missing a permission. Open the app again from Shopify Admin.`,
        );
      }
      if (res.status === 402) throw new Error("This store is frozen or unpaid (402), so Shopify does not accept changes.");
      if (res.status === 404) throw new Error(`Shopify store not found (404): ${this.shop}`);
      const body = await res.json();
      if (body.errors) {
        const throttled = body.errors.some?.((e: { extensions?: { code?: string } }) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < 10) {
          await sleep(2000);
          continue;
        }
        throw new GraphqlError(`Shopify error: ${JSON.stringify(body.errors).slice(0, 600)}`, body.errors);
      }
      // Close to the rate limit: wait a little
      const t = body.extensions?.cost?.throttleStatus;
      if (t && t.currentlyAvailable < 300) await sleep(((300 - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000);
      return body.data;
    }
  }

  async getProduct(id: string): Promise<ShopifyProduct | null> {
    const d = await this.gql(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
    return flatten(d.product);
  }

  // by = sku | barcode | handle | title | tag | id. values = values from this product's rows.
  // Matching ignores capital letters and extra spaces/symbols in titles.
  async findProduct(by: string, values: string[]): Promise<FindResult> {
    const wanted = [...new Set(values.filter(Boolean).map((v) => String(v).trim()))];
    if (by === "sku" || by === "barcode") {
      for (const v of wanted) {
        const d = await this.gql(
          `query($q: String!) { productVariants(first: 10, query: $q) { nodes { sku barcode product { ${PRODUCT_FIELDS} } } } }`,
          { q: `${by}:${q(v)}` },
        );
        const hits = d.productVariants.nodes.filter(
          (n: any) => String(n[by] || "").trim().toLowerCase() === v.toLowerCase(),
        );
        const ids = [...new Set(hits.map((h: any) => h.product.id))];
        if (ids.length > 1) return { ambiguous: `${by.toUpperCase()} "${v}" is used by ${ids.length} different products` };
        if (hits.length) return { product: flatten(hits[0].product) };
      }
      return { product: null };
    }
    if (by === "id") {
      for (const v of wanted) {
        const num = (v.match(/(\d{6,})\s*$/) || v.match(/products\/(\d+)/) || [])[1];
        if (!num) continue;
        const p = await this.getProduct(`gid://shopify/Product/${num}`);
        if (p) return { product: p };
      }
      return { product: null };
    }
    for (const v of wanted) {
      const query = by === "handle" ? `handle:${q(v)}` : by === "tag" ? `tag:${q(v)}` : `title:${q(v)}`;
      const d = await this.gql(`query($q: String!) { products(first: 10, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`, {
        q: query,
      });
      const hits = d.products.nodes.filter((p: ShopifyProduct) =>
        by === "handle"
          ? p.handle === v.toLowerCase()
          : by === "tag"
            ? p.tags.some((t) => norm(t) === norm(v))
            : norm(p.title) === norm(v),
      );
      if (hits.length > 1) {
        return {
          ambiguous: by === "tag" ? `${hits.length} products have the tag "${v}"` : `${hits.length} products are called "${v}"`,
        };
      }
      if (hits.length) return { product: flatten(hits[0]) };
    }
    return { product: null };
  }

  async loadCollections(): Promise<Map<string, Collection>> {
    const map = new Map<string, Collection>();
    let after: string | null = null;
    do {
      const d: any = await this.gql(
        `query($after: String) { collections(first: 250, after: $after) {
           pageInfo { hasNextPage endCursor } nodes { id title handle ruleSet { appliedDisjunctively } } } }`,
        { after },
      );
      for (const c of d.collections.nodes) {
        const col = { id: c.id, title: c.title, handle: c.handle, smart: !!c.ruleSet };
        map.set(norm(c.title), col);
        if (!map.has(norm(c.handle))) map.set(norm(c.handle), col);
      }
      after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
    } while (after);
    return map;
  }

  async createCollection(title: string): Promise<Collection> {
    const d = await this.gql(
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id title handle } userErrors { field message } } }`,
      { input: { title } },
    );
    const r = d.collectionCreate;
    if (r.userErrors.length) {
      throw new Error(`Could not create collection "${title}": ${r.userErrors.map((e: any) => e.message).join("; ")}`);
    }
    return { id: r.collection.id, title: r.collection.title, handle: r.collection.handle, smart: false };
  }

  async addToCollection(collectionId: string, productId: string): Promise<void> {
    const d = await this.gql(
      `mutation($id: ID!, $p: [ID!]!) { collectionAddProducts(id: $id, productIds: $p) { userErrors { field message } } }`,
      { id: collectionId, p: [productId] },
    );
    const errs = d.collectionAddProducts.userErrors;
    if (errs.length && !errs.every((e: any) => /already/i.test(e.message))) {
      throw new Error(errs.map((e: any) => e.message).join("; "));
    }
  }

  // Uploads an image to Shopify's temporary storage and returns its URL (used by productSet / productUpdate)
  async stageImage(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
    const d = await this.gql(
      `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
         stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
      { input: [{ resource: "IMAGE", filename, mimeType, httpMethod: "POST", fileSize: String(buffer.length) }] },
    );
    const r = d.stagedUploadsCreate;
    if (r.userErrors.length) {
      throw new Error(`Could not prepare image upload: ${r.userErrors.map((e: any) => e.message).join("; ")}`);
    }
    const target = r.stagedTargets[0];
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      for (const p of target.parameters) form.append(p.name, p.value);
      form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
      const res = await fetch(target.url, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
      if (res.ok) break;
      if (attempt < 3 && res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`Upload of image "${filename}" failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    return target.resourceUrl;
  }

  async productSet(input: ProductSetInput): Promise<{ id: string; handle: string; title: string }> {
    const out = `product { id handle title } userErrors { field message code }`;
    let d;
    try {
      d = await this.gql(`mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) { ${out} } }`, {
        input,
      });
    } catch (e) {
      // Newer API versions identify an existing product through the "identifier" argument
      const noIdField =
        input.id &&
        e instanceof GraphqlError &&
        e.graphqlErrors.some((x) => /ProductSetInput/.test(x.message) && /\bid\b/.test(x.message));
      if (!noIdField) throw e;
      const { id, ...rest } = input;
      d = await this.gql(
        `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
           productSet(synchronous: true, input: $input, identifier: $identifier) { ${out} } }`,
        { input: rest, identifier: { id } },
      );
    }
    const r = d.productSet;
    if (r.userErrors.length) {
      throw new Error(
        `Product not saved: ${r.userErrors.map((e: any) => `${(e.field || []).join(".")} ${e.message}`).join("; ")}`,
      );
    }
    return r.product;
  }

  // Adds new images to an existing product without touching its current images
  async appendMedia(
    productId: string,
    media: { originalSource: string; alt: string; mediaContentType: "IMAGE" }[],
  ): Promise<void> {
    const d = await this.gql(
      `mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
         productUpdate(product: $product, media: $media) { product { id } userErrors { field message } } }`,
      { product: { id: productId }, media },
    );
    const errs = d.productUpdate.userErrors;
    if (errs.length) throw new Error(`Images not added: ${errs.map((e: any) => e.message).join("; ")}`);
  }

  async metafieldsSet(ownerId: string, metafields: MetafieldInput[]): Promise<void> {
    for (let i = 0; i < metafields.length; i += 25) {
      const chunk = metafields.slice(i, i + 25).map((m) => ({ ownerId, ...m }));
      const d = await this.gql(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key namespace } userErrors { field message code } } }`,
        { m: chunk },
      );
      const errs = d.metafieldsSet.userErrors;
      if (errs.length) {
        throw new Error(`Metafield not saved: ${errs.map((e: any) => `${(e.field || []).join(".")} ${e.message}`).join("; ")}`);
      }
    }
  }
}
