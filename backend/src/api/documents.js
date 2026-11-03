import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BUCKET = "application-documents";

function safeExtension(filename = "") {
  const extension = path.extname(path.win32.basename(path.basename(filename))).toLowerCase();
  return [".pdf", ".jpg", ".jpeg", ".png"].includes(extension) ? extension : ".pdf";
}

function contentTypeFor(extension) {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "application/pdf";
}

// Keeps uploaded PDFs on this computer (used for demos and tests).
export function createLocalStorage(root) {
  const fileFor = (applicationId, document, filename) => path.join(root, applicationId, `${document}${safeExtension(filename)}`);
  return {
    kind: "local",
    async save(applicationId, document, buffer, filename) {
      await fs.mkdir(path.join(root, applicationId), { recursive: true });
      await fs.writeFile(fileFor(applicationId, document, filename), buffer);
    },
    // Gives `callback` a file path it can read.
    async withFile(applicationId, document, callback, filename) {
      return callback(fileFor(applicationId, document, filename));
    },
    async remove(applicationId) {
      await fs.rm(path.join(root, applicationId), { recursive: true, force: true });
    },
  };
}

// Keeps uploaded PDFs in a PRIVATE Supabase Storage bucket.
// Only the backend (secret key) can reach it; the browser never gets a file link.
export function createSupabaseStorage(client, bucket = BUCKET) {
  const objectPath = (applicationId, document, filename) => `${applicationId}/${document}${safeExtension(filename)}`;
  const files = () => client.storage.from(bucket);
  return {
    kind: "supabase",
    async save(applicationId, document, buffer, filename) {
      const extension = safeExtension(filename);
      const { error } = await files().upload(objectPath(applicationId, document, filename), buffer, {
        contentType: contentTypeFor(extension),
        upsert: true,
      });
      if (error) throw new Error(`Could not store the document: ${error.message}`);
    },
    // Downloads the PDF to a temporary file, runs `callback`, then always deletes the temporary file.
    async withFile(applicationId, document, callback, filename) {
      const extension = safeExtension(filename);
      const { data, error } = await files().download(objectPath(applicationId, document, filename));
      if (error || !data) {
        throw new Error(`Could not read the stored document (${document}): ${error?.message ?? "not found"}`);
      }
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-"));
      const filePath = path.join(directory, `${document}${extension}`);
      try {
        await fs.writeFile(filePath, Buffer.from(await data.arrayBuffer()));
        return await callback(filePath);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    async remove(applicationId, documents) {
      if (!documents?.length) return;
      const { error } = await files().remove(documents.map((item) =>
        objectPath(applicationId, typeof item === "string" ? item : item.document, typeof item === "string" ? undefined : item.filename)));
      if (error) throw new Error(`Could not remove stored documents: ${error.message}`);
    },
  };
}
