import type { Settings } from "../../lib/uploader";
import { Checkbox, Select } from "../polaris";

export function RulesSection({ s, update }: { s: Settings; update: (fn: (d: Settings) => void) => void }) {
  return (
    <s-section heading="4. Update rules">
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="repeat(auto-fill, minmax(230px, 1fr))" gap="base">
          <Select
            label="Tags"
            value={s.options?.tags_mode || "append"}
            onChange={(v) =>
              update((d) => {
                d.options = { ...d.options, tags_mode: v as "append" | "replace" };
              })
            }
            options={[
              { value: "append", label: "Add new tags, keep existing ones" },
              { value: "replace", label: "Keep only the sheet's tags" },
            ]}
          />
          <Select
            label="Status of new products"
            value={s.match?.new_product_status || "DRAFT"}
            onChange={(v) =>
              update((d) => {
                d.match = { ...d.match, new_product_status: v };
              })
            }
            options={[
              { value: "DRAFT", label: "Draft (review before publishing)" },
              { value: "ACTIVE", label: "Active (live immediately)" },
            ]}
          />
          <Select
            label="Speed"
            details="Shopify rate limits are handled automatically"
            value={String(s.options?.concurrency || 4)}
            onChange={(v) =>
              update((d) => {
                d.options = { ...d.options, concurrency: Number(v) };
              })
            }
            options={[
              { value: "1", label: "1 product at a time (slowest, safest)" },
              { value: "2", label: "2 at a time" },
              { value: "4", label: "4 at a time (recommended)" },
              { value: "6", label: "6 at a time" },
              { value: "8", label: "8 at a time (fastest)" },
            ]}
          />
        </s-grid>
        <s-stack direction="block" gap="small-200">
          <Checkbox
            label="Create products that are not in Shopify"
            checked={!!s.match?.create_missing}
            onChange={(v) =>
              update((d) => {
                d.match = { ...d.match, create_missing: v };
              })
            }
          />
          <Checkbox
            label="Create collections that do not exist"
            checked={!!s.options?.create_missing_collections}
            onChange={(v) =>
              update((d) => {
                d.options = { ...d.options, create_missing_collections: v };
              })
            }
          />
          <Checkbox
            label="Keep existing variants that are not in the sheet"
            details="Untick only if variants missing from the sheet should be deleted"
            checked={s.options?.keep_unlisted_variants !== false}
            onChange={(v) =>
              update((d) => {
                d.options = { ...d.options, keep_unlisted_variants: v };
              })
            }
          />
        </s-stack>
      </s-stack>
    </s-section>
  );
}
