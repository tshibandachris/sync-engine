export interface PresignedPut {
  url: string;
  expiresIn: number;
}

export interface PresignedGet {
  url: string;
  expiresIn: number;
}

export interface HeadResult {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}

export interface AttachmentStorage {
  /**
   * Deletes one object. Must be idempotent: deleting an already-absent
   * key is not an error, so a retry after a network blip is safe.
   */
  delete(objectKey: string): Promise<void>;

  presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<PresignedPut>;
  presignGet(objectKey: string, expiresIn: number): Promise<PresignedGet>;
  head(objectKey: string): Promise<HeadResult>;
}
