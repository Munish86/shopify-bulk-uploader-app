import { useRef, useState } from "react";
import type { Settings } from "../../lib/uploader";
import { Button, Segmented, Select, TextField } from "../polaris";
import { api } from "./api";
import styles from "./uploader.module.css";

const IMG_RE = /\.(jpe?g|png|webp|gif|avif|heic)$/i;
const PARALLEL = 4;

// A dropped folder arrives as directory entries; walk them to get every file with its folder path
async function filesFromDrop(e: React.DragEvent): Promise<{ file: File; path: string }[]> {
  // Entries must be taken before the first await: the browser clears the drop data afterwards
  const entries = [...(e.dataTransfer.items || [])]
    .map((it) => it.webkitGetAsEntry?.())
    .filter((x): x is FileSystemEntry => !!x);
  if (!entries.length) return [...e.dataTransfer.files].map((file) => ({ file, path: file.name }));
  const out: { file: File; path: string }[] = [];
  const readAll = (reader: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const acc: FileSystemEntry[] = [];
      // readEntries returns at most 100 entries per call
      const next = () =>
        reader.readEntries((batch) => {
          if (!batch.length) return resolve(acc);
          acc.push(...batch);
          next();
        }, reject);
      next();
    });
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((r, reject) => (entry as FileSystemFileEntry).file(r, reject));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) {
        await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}

export function ImagesSection({
  s,
  update,
  imageCount,
  refreshImages,
  googleEmail,
  locked,
}: {
  s: Settings;
  update: (fn: (d: Settings) => void) => void;
  imageCount: number;
  refreshImages: () => Promise<void>;
  googleEmail: string;
  locked: boolean;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [over, setOver] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const source = (s.images?.source as "none" | "upload" | "drive") || "none";

  async function upload(list: { file: File; path: string }[]) {
    const files = list.filter((f) => IMG_RE.test(f.file.name));
    setFailed([]);
    setMessage(files.length ? "" : "No image files (jpg, png, webp, gif) found there.");
    if (!files.length) return;
    let done = 0;
    let next = 0;
    const errors: string[] = [];
    setProgress({ done, total: files.length });
    const worker = async () => {
      while (next < files.length) {
        const { file, path } = files[next++];
        try {
          await api(`/app/api/files?kind=image&name=${encodeURIComponent(path)}`, { method: "POST", body: file });
        } catch (e) {
          errors.push(`${path}: ${(e as Error).message}`);
          // A limit or a run in progress affects every file: stop early
          if ([409, 413].includes((e as { status?: number }).status ?? 0) && /limit|up to|in progress/i.test((e as Error).message)) {
            next = files.length;
          }
        }
        done++;
        setProgress({ done, total: files.length });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setProgress(null);
    setFailed(errors);
    await refreshImages();
  }

  async function clearAll() {
    setConfirmClear(false);
    try {
      await api("/app/api/files?kind=image", { method: "DELETE" });
    } catch (e) {
      setMessage((e as Error).message);
    }
    await refreshImages();
  }

  return (
    <s-section heading="3. Images">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Image file names must match the &quot;Image name&quot; column. <code>Oslo Sofa.jpg</code>,{" "}
          <code>oslo-sofa_1.jpg</code> and <code>Oslo Sofa (2).png</code> all belong to &quot;Oslo Sofa&quot;, in that
          order. Sub-folders are fine.
        </s-paragraph>
        <Segmented
          value={source}
          onChange={(v) =>
            update((d) => {
              d.images = { ...d.images, source: v };
            })
          }
          options={[
            { value: "none", label: "No images" },
            { value: "upload", label: "Upload images" },
            { value: "drive", label: "Google Drive folder" },
          ]}
        />

        {source === "none" && (
          <s-text color="subdued">Product images are not changed. Choose another option only when you want to add images.</s-text>
        )}

        {source === "upload" && (
          <s-stack direction="block" gap="small-200">
            <div
              className={`${styles.drop} ${over ? styles.dropOver : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={async (e) => {
                e.preventDefault();
                setOver(false);
                if (locked || progress) return;
                await upload(await filesFromDrop(e));
              }}
            >
              <s-stack direction="block" gap="small-200" alignItems="center">
                <s-text>Drag your images folder here</s-text>
                <input
                  ref={folderInput}
                  type="file"
                  hidden
                  multiple
                  {...{ webkitdirectory: "" }}
                  onChange={(e) => {
                    const list = [...(e.target.files || [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
                    e.target.value = "";
                    void upload(list);
                  }}
                />
                <input
                  ref={filesInput}
                  type="file"
                  hidden
                  multiple
                  accept="image/*"
                  onChange={(e) => {
                    const list = [...(e.target.files || [])].map((file) => ({ file, path: file.name }));
                    e.target.value = "";
                    void upload(list);
                  }}
                />
                <s-stack direction="inline" gap="small-200">
                  <Button onClick={() => folderInput.current?.click()} disabled={locked || !!progress}>
                    Choose folder
                  </Button>
                  <Button onClick={() => filesInput.current?.click()} disabled={locked || !!progress}>
                    Choose images
                  </Button>
                </s-stack>
              </s-stack>
            </div>
            {progress && (
              <s-stack direction="block" gap="small-200">
                <div className={styles.bar}>
                  <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                </div>
                <s-text>
                  Uploading images: {progress.done} / {progress.total}
                </s-text>
              </s-stack>
            )}
            {!progress && (
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text>{imageCount ? `${imageCount} images uploaded` : "No images uploaded yet."}</s-text>
                {imageCount > 0 && !confirmClear && (
                  <Button variant="tertiary" onClick={() => setConfirmClear(true)} disabled={locked}>
                    Remove all uploaded images
                  </Button>
                )}
              </s-stack>
            )}
            {confirmClear && (
              <s-banner tone="warning" heading="Remove all uploaded images from the app?">
                <s-stack direction="block" gap="small-200">
                  <s-text>Nothing changes in Shopify.</s-text>
                  <s-stack direction="inline" gap="small-200">
                    <Button tone="critical" onClick={() => void clearAll()}>
                      Remove
                    </Button>
                    <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
                  </s-stack>
                </s-stack>
              </s-banner>
            )}
            {locked && <s-text color="subdued">Images cannot be changed while a run is in progress.</s-text>}
            <s-text color="subdued">Uploaded files are kept for 7 days.</s-text>
          </s-stack>
        )}

        {source === "drive" && (
          <s-stack direction="block" gap="small-200">
            <TextField
              label="Google Drive folder link"
              placeholder="https://drive.google.com/drive/folders/..."
              value={s.images?.drive_folder || ""}
              onChange={(v) =>
                update((d) => {
                  d.images = { ...d.images, drive_folder: v };
                })
              }
            />
            <s-text color="subdued">
              {googleEmail
                ? `Share the folder (Viewer) with ${googleEmail}. Sub-folders are included.`
                : "Google Drive is not set up on this app yet."}
            </s-text>
          </s-stack>
        )}

        {message && <s-banner tone="warning">{message}</s-banner>}
        {failed.length > 0 && (
          <s-banner tone="critical" heading={`${failed.length} images were not uploaded`}>
            <s-unordered-list>
              {failed.slice(0, 10).map((f) => (
                <s-list-item key={f}>{f}</s-list-item>
              ))}
            </s-unordered-list>
          </s-banner>
        )}

        {source !== "none" && (
          <Select
            label="When a product already has images"
            value={s.images?.mode || "append"}
            onChange={(v) =>
              update((d) => {
                d.images = { ...d.images, mode: v as "append" | "replace" | "skip_if_has_images" };
              })
            }
            options={[
              { value: "append", label: "Add new images, keep existing ones" },
              { value: "skip_if_has_images", label: "Skip products that already have images" },
              { value: "replace", label: "Replace all existing images" },
            ]}
          />
        )}
      </s-stack>
    </s-section>
  );
}
