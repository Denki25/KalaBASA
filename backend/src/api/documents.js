import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const BUCKET = "application-documents";

// Keeps uploaded PDFs on this computer (used for demos and tests).
export function createLocalStorage(root) {
  const fileFor = (applicationId, document) => path.join(root, applicationId, `${document}.pdf`);
  return {
    kind: "local",
    async save(applicationId, document, buffer) {
      await fs.mkdir(path.join(root, applicationId), { recursive: true });
      await fs.writeFile(fileFor(applicationId, document), buffer);
    },
    // Gives `callback` a file path it can read.
    async withFile(applicationId, document, callback) {
      return callback(fileFor(applicationId, document));
    },
    async remove(applicationId) {
      await fs.rm(path.join(root, applicationId), { recursive: true, force: true });
    },
  };
}

// Keeps uploaded PDFs in a PRIVATE Supabase Storage bucket.
// Only the backend (secret key) can reach it; the browser never gets a file link.
export function createSupabaseStorage(client, bucket = BUCKET) {
  const objectPath = (applicationId, document) => `${applicationId}/${document}.pdf`;
  const files = () => client.storage.from(bucket);
  return {
    kind: "supabase",
    async save(applicationId, document, buffer) {
      const { error } = await files().upload(objectPath(applicationId, document), buffer, {
        contentType: "application/pdf",
        upsert: true,
      });
      if (error) throw new Error(`Could not store the document: ${error.message}`);
    },
    // Downloads the PDF to a temporary file, runs `callback`, then always deletes the temporary file.
    async withFile(applicationId, document, callback) {
      const { data, error } = await files().download(objectPath(applicationId, document));
      if (error || !data) {
        throw new Error(`Could not read the stored document (${document}): ${error?.message ?? "not found"}`);
      }
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kalabasa-"));
      const filePath = path.join(directory, `${document}.pdf`);
      try {
        await fs.writeFile(filePath, Buffer.from(await data.arrayBuffer()));
        return await callback(filePath);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    async remove(applicationId, documents) {
      if (!documents?.length) return;
      const { error } = await files().remove(documents.map((document) => objectPath(applicationId, document)));
      if (error) throw new Error(`Could not remove stored documents: ${error.message}`);
    },
  };
}
