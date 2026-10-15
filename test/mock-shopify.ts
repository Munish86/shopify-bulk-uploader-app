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
      metafields: [{ namespace: "custom", key: "material", type: "single_line_text_field", value: "Pine" }],
    },
  ];
  for (const p of products) {
    Object.assign(p, { seo: { title: null, description: null }, updatedAt: "2020-01-01T00:00:00Z", metafields: p.metafields || [] });
  }
  const touch = (p: any) => (p.updatedAt = new Date().toISOString());
  const byId = (id: string) => products.find((x) => x.id === id);
  const SCALARS = ["title", "descriptionHtml", "vendor", "productType", "status", "tags"];
  const addMedia = (p: any, list?: any[]) => {
    for (const m of list || []) {
      p.media.nodes.push({ id: gid("MediaImage"), alt: m.alt || "", mediaContentType: "IMAGE", image: { url: m.originalSource } });
    }
  };
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
    // Before the list queries below: a product query also asks for collections(first: 250)
    if (/product\(id: \$id\) \{ metafields/.test(query)) {
      const p = byId(v.id);
      return ok({ product: p ? { metafields: { nodes: p.metafields } } : null });
    }
    if (/product\(id: \$id\)/.test(query)) return ok({ product: byId(v.id) || null });
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
    if (/collectionAddProducts/.test(query)) {
      const c = collections.find((x) => x.id === v.id);
      for (const pid of v.p) {
        const p = byId(pid);
        if (p && c && !p.collections.nodes.some((x: any) => x.id === c.id)) {
          p.collections.nodes.push({ id: c.id, title: c.title, ruleSet: c.ruleSet });
        }
      }
      return ok({ collectionAddProducts: { userErrors: [] } });
    }
    if (/collectionRemoveProducts/.test(query)) {
      for (const pid of v.p) {
        const p = byId(pid);
        if (p) p.collections.nodes = p.collections.nodes.filter((x: any) => x.id !== v.id);
      }
      return ok({ collectionRemoveProducts: { userErrors: [] } });
    }
    if (/productVariantsBulkUpdate/.test(query)) {
      const p = byId(v.productId);
      for (const u of v.variants) {
        const vr = p.variants.nodes.find((x: any) => x.id === u.id);
        for (const k of ["price", "compareAtPrice", "barcode"]) if (k in u) vr[k] = u[k];
        if (u.inventoryItem) vr.sku = u.inventoryItem.sku;
      }
      touch(p);
      return ok({ productVariantsBulkUpdate: { userErrors: [] } });
    }
    if (/metafieldsDelete/.test(query)) {
      for (const m of v.m) {
        const p = byId(m.ownerId);
        p.metafields = p.metafields.filter((x: any) => !(x.namespace === m.namespace && x.key === m.key));
      }
      return ok({ metafieldsDelete: { userErrors: [] } });
    }
    if (/fileDelete/.test(query)) {
      for (const p of products) p.media.nodes = p.media.nodes.filter((m: any) => !v.ids.includes(m.id));
      return ok({ fileDelete: { deletedFileIds: v.ids, userErrors: [] } });
    }
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
          seo: { title: null, description: null },
          metafields: [],
        };
        products.push(p);
      }
      for (const k of SCALARS) if (input[k] !== undefined) p[k] = input[k];
      if (input.seo) p.seo = { ...p.seo, ...input.seo };
      if (input.variants) {
        // productSet keeps only the variants it is given
        p.variants.nodes = input.variants.map((iv: any) => {
          const old = p.variants.nodes.find((x: any) => x.id && x.id === iv.id) || {
            id: gid("ProductVariant"),
            sku: null,
            price: "0.00",
            compareAtPrice: null,
            barcode: null,
          };
          const { optionValues, ...f } = iv;
          return { ...old, ...f, id: old.id, selectedOptions: optionValues.map((o: any) => ({ name: o.optionName, value: o.name })) };
        });
      }
      if (input.files) {
        p.media.nodes = [];
        addMedia(p, input.files);
      }
      touch(p);
      return ok({ productSet: { product: { id: p.id, handle: p.handle, title: p.title }, userErrors: [] } });
    }
    if (/productUpdate/.test(query)) {
      const p = byId(v.product.id);
      for (const k of SCALARS) if (v.product[k] !== undefined) p[k] = v.product[k];
      if (v.product.seo) p.seo = { ...v.product.seo };
      addMedia(p, v.media);
      touch(p);
      return ok({ productUpdate: { product: { id: v.product.id }, userErrors: [] } });
    }
    if (/metafieldsSet/.test(query)) {
      for (const m of v.m) {
        const p = byId(m.ownerId);
        const cur = p.metafields.find((x: any) => x.namespace === m.namespace && x.key === m.key);
        if (cur) Object.assign(cur, { type: m.type, value: m.value });
        else p.metafields.push({ namespace: m.namespace, key: m.key, type: m.type, value: m.value });
      }
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
