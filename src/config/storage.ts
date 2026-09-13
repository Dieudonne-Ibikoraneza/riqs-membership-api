import { Client as MinioClient } from 'minio';

// Replaces Supabase Storage (see storage/ at the repo root for the self-hosted MinIO service
// itself). This module exposes the exact same shape the ~8 existing call sites were already
// written against (`<client>.storage.from(bucket).upload/download/remove`) — a Supabase
// Storage client shim, not a redesign — so those call sites only needed their import swapped,
// not rewritten.

const endPoint = process.env.MINIO_ENDPOINT || 'localhost';
const port = Number(process.env.MINIO_API_PORT || 9000);
const useSSL = process.env.MINIO_USE_SSL === 'true';
const accessKey = process.env.MINIO_ACCESS_KEY || '';
const secretKey = process.env.MINIO_SECRET_KEY || '';

const minioClient = new MinioClient({ endPoint, port, useSSL, accessKey, secretKey });

export interface StorageUploadOptions {
  contentType?: string;
  /** Seconds, as a string — matches how the existing call sites already pass it
   *  (Supabase's own convention); rendered as `Cache-Control: max-age=<value>`. */
  cacheControl?: string;
  /** Supabase rejects an upload to an existing path when this is false. MinIO's putObject
   *  always overwrites, so that check is emulated with a statObject probe below. Defaults to
   *  true (overwrite), same default Supabase's client uses. */
  upsert?: boolean;
}

interface StorageResult<T> {
  data: T | null;
  error: (Error & { statusCode?: string }) | null;
}

async function objectExists(bucket: string, path: string): Promise<boolean> {
  try {
    await minioClient.statObject(bucket, path);
    return true;
  } catch {
    return false;
  }
}

// MinIO SDK errors use `.code` (e.g. "NoSuchKey"), not Supabase's `.statusCode`/`.status` —
// existing call sites check the latter to decide "not found" vs. a real failure, so normalize
// it here rather than touching every call site's error-handling.
function normalizeError(err: any): Error & { statusCode?: string } {
  const e = err instanceof Error ? err : new Error(String(err?.message || err));
  if (err?.code === 'NoSuchKey' || err?.code === 'NotFound') {
    (e as any).statusCode = '404';
  }
  return e;
}

function bucketApi(bucket: string) {
  return {
    async upload(path: string, buffer: Buffer, options: StorageUploadOptions = {}): Promise<StorageResult<{ path: string }>> {
      try {
        if (options.upsert === false && (await objectExists(bucket, path))) {
          return { data: null, error: Object.assign(new Error(`The resource already exists: ${path}`), { statusCode: '409' }) };
        }
        const metaData: Record<string, string> = {};
        if (options.contentType) metaData['Content-Type'] = options.contentType;
        if (options.cacheControl) metaData['Cache-Control'] = `max-age=${options.cacheControl}`;
        await minioClient.putObject(bucket, path, buffer, buffer.length, metaData);
        return { data: { path }, error: null };
      } catch (err: any) {
        return { data: null, error: normalizeError(err) };
      }
    },

    async download(path: string): Promise<StorageResult<{ arrayBuffer: () => Promise<ArrayBuffer>; type: string }>> {
      try {
        const stream = await minioClient.getObject(bucket, path);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        const buffer = Buffer.concat(chunks);
        return {
          data: {
            type: 'application/octet-stream',
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
          },
          error: null,
        };
      } catch (err: any) {
        return { data: null, error: normalizeError(err) };
      }
    },

    async remove(paths: string[]): Promise<StorageResult<null>> {
      try {
        // removeObject (singular) rather than the batch removeObjects call — every existing
        // call site only ever removes one path at a time, and this avoids depending on the
        // batch API's exact error-reporting shape across minio SDK versions.
        await Promise.all(paths.map((p) => minioClient.removeObject(bucket, p)));
        return { data: null, error: null };
      } catch (err: any) {
        return { data: null, error: normalizeError(err) };
      }
    },
  };
}

export const objectStorage = {
  storage: {
    from(bucket: string) {
      return bucketApi(bucket);
    },
  },
};

// The one bucket this app has ever used (matches the MinIO deploy's init-bucket.sh default,
// and the MINIO_BUCKET value documented in storage/README.md).
export const DEFAULT_BUCKET = process.env.MINIO_BUCKET || 'riqs-membership';
