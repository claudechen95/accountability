import { Index } from "@upstash/vector";

interface TranscriptChunkMetadata {
  day: string;
  session: string;
  file: string;
  chunkIndex: number;
  [key: string]: unknown;
}

// Shared Upstash Vector database (also used by the unrelated provenance-mcp project) —
// namespaced so this app's transcript chunks never collide with its data.
const COACH_NAMESPACE = "coach-transcripts";

const index = new Index<TranscriptChunkMetadata>({
  url: process.env.UPSTASH_VECTOR_REST_URL!,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN!,
}).namespace(COACH_NAMESPACE);

export interface TranscriptExcerpt {
  text: string;
  day: string;
  session: string;
  score: number;
}

// Semantic search over the ingested coaching transcripts (see scripts/ingest-transcripts.mjs).
// Relies on the index's hosted embedding model to embed `query` server-side.
export async function searchTranscripts(query: string, topK = 6): Promise<TranscriptExcerpt[]> {
  const results = await index.query({
    data: query,
    topK,
    includeMetadata: true,
    includeData: true,
  });

  return results
    .filter((r) => typeof r.data === "string")
    .map((r) => ({
      text: r.data as string,
      day: r.metadata?.day ?? "",
      session: r.metadata?.session ?? "",
      score: r.score,
    }));
}
