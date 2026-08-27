declare module "node-llama-cpp" {
  export enum LlamaLogLevel {
    error = 0,
  }

  export type LlamaEmbedding = { vector: Float32Array | number[] };

  export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
  };

  export type LlamaModel = {
    createEmbeddingContext: () => Promise<LlamaEmbeddingContext>;
  };

  export type Llama = {
    loadModel: (params: { modelPath: string }) => Promise<LlamaModel>;
  };

  export function getLlama(params: { logLevel: LlamaLogLevel }): Promise<Llama>;
  export type ResolveModelFileOptions = {
    directory?: string;
    cli?: boolean;
    onProgress?: (status: { totalSize: number; downloadedSize: number }) => void;
  };

  export function resolveModelFile(
    modelPath: string,
    optionsOrDirectory?: ResolveModelFileOptions | string,
  ): Promise<string>;
}
