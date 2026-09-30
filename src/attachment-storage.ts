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
  presignPut(objectKey: string, contentType: string, expiresIn: number): Promise<PresignedPut>;
  presignGet(objectKey: string, expiresIn: number): Promise<PresignedGet>;
  head(objectKey: string): Promise<HeadResult>;
}
