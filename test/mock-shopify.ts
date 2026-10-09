/* eslint-disable @typescript-eslint/no-explicit-any -- loose test data */
// A simulated Shopify GraphQL server for tests, so the full flow can run without touching a real store.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockCall {
  query: string;
  variables: any;
}

export async function startMock() {
  const calls: MockCall[] = [];
  const uploads: number[] = [];
  let nextId = 100;
  const gid = (t: string) => `gid://shopify/${t}/${nextId++}`;
  const products: any[] = [
    {
      id: "gid://shopify/Product/1",
      handle: "oslo-3-seater-sofa",
      title: "Oslo 3 Seater Sofa",
      status: "ACTIVE",
      tags: ["sofa"],
      vendor: "Urban Wood Co",
      productType: "Sofa",
      descriptionHtml: "<p>old</p>",
      options: [
        { name: "Colour", optionValues: [{ name: "Grey" }] },
        { name: "Size", optionValues: [{ name: "3 Seater" }] },
      ],
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/11",
            sku: "OSLO-3S-GRY",
            price: "1299.00",
            compareAtPrice: null,
            barcode: null,
            selectedOptions: [
              { name: "Colour", value: "Grey" },
              { name: "Size", value: "3 Seater" },
            ],
          },
        ],
      },
      media: { nodes: [] },
      collections: { nodes: [] },
    },
    {
      id: "gid://shopify/Product/2",
      handle: "aria-king-size-bed",
      title: "Aria King Size Bed",
      status: "ACTIVE",
      tags: ["bed", "bedroom", "storage"],
      vendor: "Sleepwell Supplies",
      productType: "Bed",
      descriptionHtml: "<p>King size bed with hydraulic storage.</p>",
      options: [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/21",
            sku: "ARIA-KB",
            price: "849.00",
            compareAtPrice: null,
            barcode: null,
            selectedOptions: [{ name: "Title", value: "Default Title" }],
          },
        ],
      },
      media: {
        nodes: [
          {
            id: "gid://shopify/MediaImage/5",
            alt: "",
            mediaContentType: "IMAGE",
            image: { url: "https://cdn.shopify.com/s/files/1/0/files/Aria_King_Bed_3f2a9c1e-1111-2222-3333-444455556666.png?v=1" },
          },
        ],
      },
      collections: { nodes: [] },
    },
  ];
  const collections: any[] = [
    { id: "gid://shopify/Collection/1", title: "Sofas", handle: "sofas", ruleSet: null },
    { id: "gid://shopify/Collection/2", title: "Beds", handle: "beds", ruleSet: null },
    { id: "gid://shopify/Collection/3", title: "Bedroom", handle: "bedroom", ruleSet: { appliedDisjunctively: false } },
  ];
  const term = (qs: string) => (qs.match(/"((?:[^"\\]|\\.)*)"/) || [])[1]?.replace(/\\"/g, '"') || "";
  const ok = (data: unknown) => ({
    data,
    extensions: { cost: { throttleStatus: { currentlyAvailable: 1900, restoreRate: 100 } } },
  });

  // unauthorizedLeft: the next N requests answer 401 (expired token). delayMs: slow every request down.
  const state = { unauthorizedLeft: 0, delayMs: 0 };

  function handle(query: string, v: any) {
    calls.push({ query, variables: v });
    if (/shop \{/.test(query)) {
      return ok({ shop: { name: "Mock Store", myshopifyDomain: "mock-store.myshopify.com", currencyCode: "INR" } });
    }
    if (/currentAppInstallation/.test(query)) {
      return ok({
        currentAppInstallation: { accessScopes: ["write_products", "write_files"].map((handle) => ({ handle })) },
      });
    }
    if (/productVariants\(/.test(query)) {
      const sku = term(v.q).toLowerCase();
      const nodes: any[] = [];
      for (const p of products) {
        for (const vr of p.variants.nodes) if ((vr.sku || "").toLowerCase() === sku) nodes.push({ sku: vr.sku, product: p });
      }
      return ok({ productVariants: { nodes } });
    }
    if (/products\(first/.test(query)) {
      const t = term(v.q).toLowerCase();
      const byHandle = v.q.startsWith("handle:");
      return ok({ products: { nodes: products.filter((p) => (byHandle ? p.handle === t : p.title.toLowerCase() === t)) } });
    }
    if (/collections\(first: 250/.test(query)) {
      return ok({ collections: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: collections } });
    }
    if (/collectionCreate/.test(query)) {
      const c = { id: gid("Collection"), title: v.input.title, handle: v.input.title.toLowerCase(), ruleSet: null };
      collections.push(c);
      return ok({ collectionCreate: { collection: c, userErrors: [] } });
    }
    if (/collectionAddProducts/.test(query)) return ok({ collectionAddProducts: { userErrors: [] } });
    if (/stagedUploadsCreate/.test(query)) {
      const i = v.input[0];
      const port = (server.address() as AddressInfo).port;
      return ok({
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: `http://127.0.0.1:${port}/upload`,
              resourceUrl: `https://mock-staged/${encodeURIComponent(i.filename)}`,
              parameters: [{ name: "key", value: "k" }],
            },
          ],
          userErrors: [],
        },
      });
    }
    if (/productSet/.test(query)) {
      const input = v.input;
      const errors: any[] = [];
      if (input.variants) {
        const names = input.productOptions.map((o: any) => o.name);
        for (const vr of input.variants) {
          if (vr.optionValues.length !== names.length || !vr.optionValues.every((o: any) => names.includes(o.optionName))) {
            errors.push({ field: ["variants"], message: "option mismatch", code: "X" });
          }
        }
      }
      if (errors.length) return ok({ productSet: { product: null, userErrors: errors } });
      let p = input.id && products.find((x) => x.id === input.id);
      if (!p) {
        p = {
          id: gid("Product"),
          handle: (input.handle || input.title).toLowerCase().replace(/\W+/g, "-"),
          title: input.title,
          tags: [],
          variants: { nodes: [] },
          media: { nodes: [] },
          collections: { nodes: [] },
          options: [],
        };
        products.push(p);
      }
      if (input.title) p.title = input.title;
      if (input.tags) p.tags = input.tags;
      if (input.descriptionHtml) p.descriptionHtml = input.descriptionHtml;
      return ok({ productSet: { product: { id: p.id, handle: p.handle, title: p.title }, userErrors: [] } });
    }
    if (/productUpdate/.test(query)) return ok({ productUpdate: { product: { id: v.product.id }, userErrors: [] } });
    if (/metafieldsSet/.test(query)) {
      return ok({
        metafieldsSet: { metafields: v.m.map((m: any) => ({ key: m.key, namespace: m.namespace })), userErrors: [] },
      });
    }
    return { errors: [{ message: `mock: unknown query ${query.slice(0, 80)}` }] };
  }

  const server = http.createServer((req, res) => {
    const body: Buffer[] = [];
    req.on("data", (c) => body.push(c));
    req.on("end", async () => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (req.url === "/upload") {
        uploads.push(Buffer.concat(body).length);
        res.writeHead(204).end();
        return;
      }
      if (state.unauthorizedLeft > 0) {
        state.unauthorizedLeft--;
        res.writeHead(401).end();
        return;
      }
      const { query, variables } = JSON.parse(Buffer.concat(body).toString());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(handle(query, variables || {})));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  return { server, endpoint, calls, uploads, products, state };
}
