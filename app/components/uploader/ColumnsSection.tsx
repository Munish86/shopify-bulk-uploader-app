import type { MatchField } from "../../.server/core/config";
import { FIELDS, MF_TYPES, RULE_FIELDS, type Settings } from "../../lib/uploader";
import { Button, Checkbox, Select, TextField } from "../polaris";
import styles from "./uploader.module.css";

export function ColumnsSection({
  s,
  update,
  headers,
  onAutoFill,
}: {
  s: Settings;
  update: (fn: (d: Settings) => void) => void;
  headers: string[];
  onAutoFill: () => void;
}) {
  const columns = (s.columns || {}) as Record<string, unknown>;
  const colOptions = (empty: string) => [{ value: "", label: empty }, ...headers.map((h) => ({ value: h, label: h }))];
  const rules = s.match?.rules || [];
  const optionCols = (s.columns?.options || []).map((o) => (typeof o === "string" ? o : o?.column || ""));
  const metafields = s.metafields || [];

  if (!headers.length) {
    return (
      <s-section heading="2. Map your columns">
        <s-paragraph>Add a product sheet first. Its column names appear here.</s-paragraph>
      </s-section>
    );
  }

  return (
    <s-section heading="2. Map your columns">
      <s-stack direction="block" gap="large">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Only map what you want to change. Everything is optional: a sheet with just a title and a meta title works.
            Empty cells never erase anything in Shopify.
          </s-paragraph>
          <s-stack direction="inline" gap="base" alignItems="center">
            <Button onClick={onAutoFill}>Auto-fill from column names</Button>
            <s-text color="subdued">Then fix anything that looks wrong.</s-text>
          </s-stack>
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-heading>Find each product in Shopify using</s-heading>
          <s-text color="subdued">
            Tried from top to bottom; the first rule that finds exactly one product is used. A column used to find
            products by title is not written back as the title. To rename products, find them by SKU or handle.
          </s-text>
          {rules.length === 0 && (
            <s-banner tone="critical">
              Add at least one way to find products, for example Title equals your &quot;Product Title&quot; column.
            </s-banner>
          )}
          {rules.map((r, i) => (
            <div key={i} className={`${styles.row} ${styles.ruleRow}`}>
              <s-text color="subdued">{i + 1}.</s-text>
              <Select
                label="Shopify field"
                labelHidden={i > 0}
                value={r?.field || "sku"}
                options={RULE_FIELDS.map(([v, l]) => ({ value: v, label: l }))}
                onChange={(v) =>
                  update((d) => {
                    d.match!.rules![i] = { ...d.match!.rules![i], field: v as MatchField };
                  })
                }
              />
              <Select
                label="equals sheet column"
                labelHidden={i > 0}
                value={r?.column || ""}
                options={colOptions("Choose column")}
                onChange={(v) =>
                  update((d) => {
                    d.match!.rules![i] = { ...d.match!.rules![i], column: v };
                  })
                }
              />
              <Button
                variant="tertiary"
                onClick={() =>
                  update((d) => {
                    d.match!.rules!.splice(i, 1);
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="tertiary"
              onClick={() =>
                update((d) => {
                  const used = new Set((d.match!.rules || []).map((x) => x?.field));
                  const next = RULE_FIELDS.find(([f]) => !used.has(f))?.[0] || "title";
                  d.match!.rules = [...(d.match!.rules || []), { field: next, column: "" }];
                })
              }
            >
              + Add another way to find products
            </Button>
          </div>
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-heading>What to update</s-heading>
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(230px, 1fr))" gap="base">
            {FIELDS.map(([k, label, hint]) => (
              <Select
                key={k}
                label={label}
                details={hint || undefined}
                value={(columns[k] as string) || ""}
                options={colOptions("Not used")}
                onChange={(v) =>
                  update((d) => {
                    const c = d.columns as Record<string, unknown>;
                    if (v) c[k] = v;
                    else delete c[k];
                  })
                }
              />
            ))}
          </s-grid>
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-heading>Variant options</s-heading>
          <s-text color="subdued">
            Columns that define variants (Colour, Size...). The column name must match the option name used in Shopify.
          </s-text>
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(180px, 1fr))" gap="small-200">
            {headers.map((h) => (
              <Checkbox
                key={h}
                label={h}
                checked={optionCols.includes(h)}
                onChange={(on) =>
                  update((d) => {
                    const now = (d.columns!.options || []).map((o) => (typeof o === "string" ? o : o?.column || ""));
                    const next = on ? [...now, h] : now.filter((x) => x !== h);
                    // Keep the sheet's column order
                    d.columns!.options = headers.filter((x) => next.includes(x));
                  })
                }
              />
            ))}
          </s-grid>
        </s-stack>

        <s-stack direction="block" gap="small-200">
          <s-heading>Metafields</s-heading>
          <s-text color="subdued">
            Use the namespace, key and type shown in Shopify Admin under Settings, then Custom data, then Products.
          </s-text>
          {metafields.map((m, i) => (
            <div key={i} className={`${styles.row} ${styles.mfRow}`}>
              <Select
                label="Sheet column"
                labelHidden={i > 0}
                value={m.column || ""}
                options={colOptions("Choose column")}
                onChange={(v) =>
                  update((d) => {
                    d.metafields![i] = { ...d.metafields![i], column: v };
                  })
                }
              />
              <TextField
                label="Namespace"
                labelHidden={i > 0}
                placeholder="custom"
                value={m.namespace || ""}
                onChange={(v) =>
                  update((d) => {
                    d.metafields![i] = { ...d.metafields![i], namespace: v };
                  })
                }
              />
              <TextField
                label="Key"
                labelHidden={i > 0}
                placeholder="material"
                value={m.key || ""}
                onChange={(v) =>
                  update((d) => {
                    d.metafields![i] = { ...d.metafields![i], key: v };
                  })
                }
              />
              <Select
                label="Type"
                labelHidden={i > 0}
                value={m.type || "single_line_text_field"}
                options={MF_TYPES.map((t) => ({ value: t, label: t }))}
                onChange={(v) =>
                  update((d) => {
                    d.metafields![i] = { ...d.metafields![i], type: v };
                  })
                }
              />
              <Button
                variant="tertiary"
                onClick={() =>
                  update((d) => {
                    d.metafields!.splice(i, 1);
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="tertiary"
              onClick={() =>
                update((d) => {
                  d.metafields = [
                    ...(d.metafields || []),
                    { column: "", namespace: "custom", key: "", type: "single_line_text_field" },
                  ];
                })
              }
            >
              + Add metafield
            </Button>
          </div>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
