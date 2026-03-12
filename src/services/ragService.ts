import { GoogleGenAI } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';

// Configurar o worker do PDF.js via CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface DocumentChunk {
  content: string;
  metadata: {
    source: string;
    id: string;
  };
  embedding?: number[];
}

export class RAGService {
  private chunks: DocumentChunk[] = [];
  private indexedIds: Set<string> = new Set();
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || "";
  }

  /**
   * Extrai texto de um PDF em base64
   */
  async extractTextFromPDF(base64: string): Promise<string> {
    try {
      const binaryString = window.atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const loadingTask = pdfjsLib.getDocument({ data: bytes });
      const pdf = await loadingTask.promise;
      let fullText = "";

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(" ");
        fullText += pageText + "\n";
      }

      return fullText;
    } catch (error) {
      console.error("Erro ao extrair texto do PDF:", error);
      return "";
    }
  }

  /**
   * Splitter simples por caracteres
   */
  private splitText(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = start + chunkSize;
      chunks.push(text.substring(start, end));
      start += chunkSize - overlap;
    }
    return chunks;
  }

  /**
   * Gera embedding para um texto usando a API do Gemini
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      if (!this.apiKey) {
        console.warn("RAGService: GEMINI_API_KEY não configurada.");
        return [];
      }
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: "models/embedding-001",
          content: { parts: [{ text }] }
        })
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error("Erro na API de Embedding:", res.status, errorData);
        return [];
      }

      const data = await res.json();
      if (!data.embedding || !data.embedding.values) {
        console.error("Resposta de embedding inválida:", data);
        return [];
      }
      return data.embedding.values;
    } catch (error) {
      console.error("Erro ao gerar embedding:", error);
      return [];
    }
  }

  /**
   * Calcula similaridade de cosseno entre dois vetores
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Indexa um documento
   */
  async indexDocument(id: string, name: string, base64: string) {
    if (this.indexedIds.has(id)) return;

    const text = await this.extractTextFromPDF(base64);
    if (!text) return;

    const textChunks = this.splitText(text);
    
    for (const content of textChunks) {
      const embedding = await this.generateEmbedding(content);
      if (embedding.length > 0) {
        this.chunks.push({
          content,
          metadata: { source: name, id },
          embedding
        });
      }
    }

    this.indexedIds.add(id);
  }

  /**
   * Busca os trechos mais relevantes
   */
  async search(query: string, k: number = 5): Promise<DocumentChunk[]> {
    const queryEmbedding = await this.generateEmbedding(query);
    if (queryEmbedding.length === 0) return [];

    const scoredChunks = this.chunks.map(chunk => ({
      chunk,
      score: this.cosineSimilarity(queryEmbedding, chunk.embedding!)
    }));

    // Ordenar por score e pegar os top K
    return scoredChunks
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(item => item.chunk);
  }

  hasDocuments(): boolean {
    return this.indexedIds.size > 0;
  }
}

export const ragService = new RAGService();
