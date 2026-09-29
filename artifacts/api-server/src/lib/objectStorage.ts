import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { getObjectAclPolicy, setObjectAclPolicy } from "./objectAcl";

// Public host used to build absolute, auth-free object URLs (matches the
// convention used in email and the in-app ApiDocs page).
export const PUBLIC_OBJECT_HOST = "https://os.presentail.com";

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

function extensionForContentType(contentType: string | undefined | null): string | null {
  if (!contentType) return null;
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[normalized] ?? null;
}

/**
 * Builds an absolute, auth-free URL for an object stored in the public bucket.
 * `publicPath` is the key relative to PUBLIC_OBJECT_SEARCH_PATHS
 * (e.g. "occasions/123.jpg"). Returns null when no path is provided.
 */
export function buildPublicObjectUrl(publicPath: string | null | undefined): string | null {
  if (!publicPath) return null;
  const clean = publicPath.replace(/^\/+/, "");
  return `${PUBLIC_OBJECT_HOST}/api/storage/public-objects/${clean}`;
}

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(file: File, cacheTtlSec: number = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }
    if (metadata.etag) {
      headers.ETag = String(metadata.etag);
    }

    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(
    workspaceOwnerId: string,
    contentType: string,
    size: number,
  ): Promise<{ signedUrl: string; requiredHeaders: Record<string, string> }> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/${workspaceOwnerId}/uploads/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    // Bind both content-type and content-length into the signed URL so the
    // storage layer rejects PUT requests with a different Content-Type or
    // a different body size, preventing metadata mismatch uploads.
    const requiredHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(size),
    };
    const signedUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
      requiredHeaders,
    });

    return { signedUrl, requiredHeaders };
  }

  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  /**
   * Persists app-generated bytes alongside normal private uploads. Generated
   * Bloomprint renders deliberately stay in the private namespace until an
   * approved product explicitly promotes its chosen image to public storage.
   */
  async savePrivateObject(
    workspaceOwnerId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/${workspaceOwnerId}/uploads/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    await objectStorageClient.bucket(bucketName).file(objectName).save(bytes, {
      resumable: false,
      metadata: { contentType },
    });
    return `/objects/${workspaceOwnerId}/uploads/${objectId}`;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  /**
   * Copies the bytes of a private object into the public bucket under a stable
   * key, so the copy is reachable via the auth-free
   * `GET /api/storage/public-objects/*` route. Returns the public key relative
   * to PUBLIC_OBJECT_SEARCH_PATHS (e.g. "occasions/123.jpg"), suitable for
   * storing on the record and rebuilding an absolute URL with
   * `buildPublicObjectUrl`. Idempotent — re-running overwrites the destination.
   *
   * @param privateImageUrl  The stored private path, e.g.
   *                         "/objects/<owner>/uploads/<uuid>".
   * @param baseKey          The destination key without extension,
   *                         e.g. "occasions/123".
   * @param ownerId          Workspace owner ID recorded in the public ACL policy.
   */
  async copyPrivateObjectToPublic(
    privateImageUrl: string,
    baseKey: string,
    ownerId: string,
  ): Promise<string> {
    const normalized = this.normalizeObjectEntityPath(privateImageUrl);
    const sourceFile = await this.getObjectEntityFile(normalized);
    const [metadata] = await sourceFile.getMetadata();
    const ext = extensionForContentType(metadata.contentType as string | undefined);
    const publicKey = ext ? `${baseKey}.${ext}` : baseKey;

    const searchPath = this.getPublicObjectSearchPaths()[0];
    const destFullPath = `${searchPath}/${publicKey}`;
    const { bucketName, objectName } = parseObjectPath(destFullPath);
    const destFile = objectStorageClient.bucket(bucketName).file(objectName);

    await sourceFile.copy(destFile);
    await setObjectAclPolicy(destFile, { owner: ownerId, visibility: "public" });

    return publicKey;
  }

  /**
   * Re-encodes a private image before publication. Sharp drops EXIF, GPS and
   * other source metadata by default; rotate applies orientation to pixels.
   */
  async copyPrivateImageToPublicSanitized(
    privateImageUrl: string,
    baseKey: string,
    ownerId: string,
  ): Promise<string> {
    const sourceFile = await this.getObjectEntityFile(this.normalizeObjectEntityPath(privateImageUrl));
    const [input] = await sourceFile.download();
    const metadata = await sharp(input).metadata();
    const format = metadata.format;
    if (format !== "jpeg" && format !== "png" && format !== "webp") {
      throw new Error("Unsupported florist publication image format");
    }
    const extension = format === "jpeg" ? "jpg" : format;
    const bytes = await sharp(input).rotate().toFormat(format).toBuffer();
    return this.savePublicObject(
      `${baseKey}.${extension}`,
      bytes,
      format === "jpeg" ? "image/jpeg" : `image/${format}`,
      ownerId,
    );
  }

  /**
   * Saves generated bytes in the public bucket and marks them public. Product
   * derivatives use versioned keys, so they can safely be cached for a year.
   */
  async savePublicObject(
    publicKey: string,
    bytes: Buffer,
    contentType: string,
    ownerId: string,
  ): Promise<string> {
    const searchPath = this.getPublicObjectSearchPaths()[0];
    const destFullPath = `${searchPath}/${publicKey}`;
    const { bucketName, objectName } = parseObjectPath(destFullPath);
    const destFile = objectStorageClient.bucket(bucketName).file(objectName);

    await destFile.save(bytes, {
      resumable: false,
      metadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    await setObjectAclPolicy(destFile, { owner: ownerId, visibility: "public" });
    return publicKey;
  }

  /** Best-effort cleanup for a public promotion that could not be persisted. */
  async deletePublicObject(publicKey: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9/_-]*\.(?:jpg|jpeg|png|webp)$/i.test(publicKey)) {
      throw new Error("Refusing to delete an unsafe public object key");
    }
    const searchPath = this.getPublicObjectSearchPaths()[0];
    const { bucketName, objectName } = parseObjectPath(`${searchPath}/${publicKey}`);
    await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  }

}

/** Shared singleton instance for use across route modules. */
export const objectStorageService = new ObjectStorageService();

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
  requiredHeaders,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
  requiredHeaders?: Record<string, string>;
}): Promise<string> {
  const request: Record<string, unknown> = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  if (requiredHeaders && Object.keys(requiredHeaders).length > 0) {
    request.headers = requiredHeaders;
  }
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = await response.json();
  return signedURL;
}
