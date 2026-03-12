/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { ragService } from './services/ragService';
import { 
  Search, 
  FileText, 
  Link as LinkIcon, 
  Upload, 
  X, 
  MessageSquare, 
  Shield, 
  Scale, 
  ChevronRight,
  ChevronDown,
  Plus,
  Loader2,
  AlertCircle,
  ExternalLink,
  History,
  Menu,
  Send
} from 'lucide-react';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: { title: string; uri: string }[];
}

interface ContextItem {
  id: string;
  type: 'url' | 'pdf';
  name: string;
  content?: string; // Base64 for PDF, URL string for URL
  mimeType?: string;
}

// --- App Component ---

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Olá! Sou o assistente de pesquisa da Polícia Civil do RS. Agora temos uma **Biblioteca Compartilhada**! Todos os documentos que você subir aqui ficarão disponíveis para seus colegas. Como posso ajudar?'
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [sharedDocs, setSharedDocs] = useState<ContextItem[]>([]);
  const [showContextPanel, setShowContextPanel] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [isLibraryExpanded, setIsLibraryExpanded] = useState(false);
  const [isLinksExpanded, setIsLinksExpanded] = useState(true);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [userHistory, setUserHistory] = useState<any[]>([]);
  const [userName, setUserName] = useState<string>(localStorage.getItem('pcrs_user_name') || '');
  const [isAdmin, setIsAdmin] = useState(false);
  const [allLogs, setAllLogs] = useState<any[]>([]);
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfCacheRef = useRef<Record<string, { name: string, content: string, mimeType: string }>>({});

  // Carregar documentos compartilhados do servidor
  const fetchSharedDocs = async () => {
    try {
      const response = await fetch('/api/documents');
      if (response.ok) {
        const data = await response.json();
        setSharedDocs(data);
      }
    } catch (error) {
      console.error("Erro ao carregar biblioteca:", error);
    }
  };

  const fetchUserHistory = async () => {
    if (!userName) return;
    try {
      const response = await fetch(`/api/messages/user/${encodeURIComponent(userName)}`);
      if (response.ok) {
        const data = await response.json();
        // Filtrar apenas as perguntas do usuário para o histórico lateral
        const questions = data.filter((m: any) => m.role === 'user');
        setUserHistory(questions);
      }
    } catch (error) {
      console.error("Erro ao carregar histórico:", error);
    }
  };

  useEffect(() => {
    fetchSharedDocs();
    if (userName) fetchUserHistory();
  }, [userName]);

  // Indexar documentos para o RAG
  useEffect(() => {
    const indexDocs = async () => {
      if (sharedDocs.length === 0 || isIndexing) return;
      
      setIsIndexing(true);
      try {
        for (const doc of sharedDocs) {
          // Só indexa se ainda não foi indexado nesta sessão
          if (doc.type === 'pdf' && !ragService.isIndexed(doc.id)) {
            let content = pdfCacheRef.current[doc.id]?.content;
            if (!content) {
              const res = await fetch(`/api/documents/${doc.id}`);
              const data = await res.json();
              content = data.content;
              pdfCacheRef.current[doc.id] = { name: doc.name, content: data.content, mimeType: data.mimeType };
            }
            
            if (content) {
              await ragService.indexDocument(doc.id, doc.name, content);
            }
          }
        }
      } catch (error) {
        console.error("Erro na indexação RAG:", error);
      } finally {
        setIsIndexing(false);
      }
    };

    indexDocs();
  }, [sharedDocs]);

  const fetchAllLogs = async () => {
    try {
      const response = await fetch('/api/messages');
      if (response.ok) {
        const data = await response.json();
        setAllLogs(data);
      }
    } catch (error) {
      console.error("Erro ao carregar logs:", error);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      fetchAllLogs();
      const interval = setInterval(fetchAllLogs, 10000); // Atualiza a cada 10s
      return () => clearInterval(interval);
    }
  }, [isAdmin]);

  const saveMessage = async (msg: Message) => {
    try {
      await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: msg.id,
          userName: userName || 'Anônimo',
          role: msg.role,
          content: msg.content
        })
      });
    } catch (error) {
      console.error("Erro ao salvar mensagem:", error);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input
    };

    setMessages(prev => [...prev, userMessage]);
    await saveMessage(userMessage);
    fetchUserHistory(); // Atualiza histórico após enviar
    setInput('');
    setIsLoading(true);

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY não configurada. Verifique as variáveis de ambiente no Render.");
      }
      
      const ai = new GoogleGenAI({ apiKey });
      
      // --- RAG: Busca Semântica ---
      // Em vez de enviar TODOS os PDFs, buscamos apenas os trechos relevantes
      const relevantDocs = await ragService.search(input, 8); // Busca os 8 trechos mais relevantes
      
      // Agrupar trechos por fonte para clareza
      const sourcesMap: Record<string, string[]> = {};
      relevantDocs.forEach(doc => {
        const source = doc.metadata.source;
        if (!sourcesMap[source]) sourcesMap[source] = [];
        sourcesMap[source].push(doc.content);
      });

      // Se não houver documentos indexados ou relevantes, ainda podemos tentar busca normal ou avisar
      const contextText = Object.entries(sourcesMap).map(([source, chunks]) => {
        return `DOCUMENTO: ${source}\nTRECHOS RELEVANTES:\n${chunks.join('\n---\n')}`;
      }).join('\n\n');

      // Prepare parts
      const parts: any[] = [];
      
      // Adicionar prompt do usuário com o contexto filtrado pelo RAG
      const contextPrompt = `
        Pergunta do Usuário: ${input}
        
        CONTEXTO EXTRAÍDO DOS DOCUMENTOS (RAG):
        ${contextText || "Nenhum trecho relevante encontrado nos documentos internos."}
        
        INSTRUÇÕES ADICIONAIS:
        1. Baseie sua resposta PRIORITARIAMENTE no contexto acima.
        2. Se o contexto for insuficiente, mencione isso e use seus conhecimentos gerais ou busca externa se apropriado.
        3. Identifique qual documento contém a informação mais recente se houver conflito.
        4. No FINAL da sua resposta, adicione uma seção chamada "--- FONTE ---" listando os nomes dos arquivos citados no contexto.
      `;

      parts.push({ text: contextPrompt });

      // Prepare tools
      const tools: any[] = [{ googleSearch: {} }];
      
      // Add URL context (links ainda são manuais por sessão)
      const urls = contextItems.filter(item => item.type === 'url').map(u => u.name);
      if (urls.length > 0) {
        tools.push({ urlContext: {} });
        parts.push({ text: `Considere também o conteúdo destes links: ${urls.join(', ')}` });
      }

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: { parts },
        config: {
          systemInstruction: `Você é um assistente jurídico especializado na Polícia Civil do Estado do Rio Grande do Sul (PCRS). 
          Sua função é ajudar policiais a encontrar e entender normas e regulamentos.
          
          REGRAS CRÍTICAS:
          1. PRIORIDADE DE ATUALIZAÇÃO: Sempre analise as datas dentro dos documentos. Se o "Documento A" diz uma coisa e o "Documento B" (mais recente) diz outra, a resposta deve seguir o "Documento B".
          2. CITAÇÃO OBRIGATÓRIA: Toda resposta deve terminar com a indicação clara de qual norma/arquivo foi utilizado.
          3. PRECISÃO: Cite artigos, parágrafos e incisos sempre que disponíveis.
          4. BUSCA EXTERNA: Se a informação não estiver nos PDFs, use o Google Search para buscar no site oficial da PCRS ou no Diário Oficial do RS, sempre priorizando a norma mais nova.
          5. FORMATO: Use Markdown para uma leitura clara.`,
          tools: tools
        }
      });

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.text || "Desculpe, não consegui processar sua solicitação.",
        sources: response.candidates?.[0]?.groundingMetadata?.groundingChunks?.map((chunk: any) => ({
          title: chunk.web?.title || "Fonte",
          uri: chunk.web?.uri || ""
        })).filter((s: any) => s.uri)
      };

      setMessages(prev => [...prev, assistantMessage]);
      await saveMessage(assistantMessage);
      fetchUserHistory(); // Atualiza histórico após resposta
    } catch (error: any) {
      console.error("Gemini Error Details:", error);
      const errorMessage = error?.message || "Erro desconhecido";
      
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Ocorreu um erro ao processar sua pergunta: ${errorMessage}. Verifique sua conexão e se a chave de API está configurada corretamente no Render.`
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach(file => {
      if (file.type !== 'application/pdf') return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = (event.target?.result as string).split(',')[1];
        const newItem: ContextItem = {
          id: Math.random().toString(36).substr(2, 9),
          type: 'pdf',
          name: file.name,
          content: base64,
          mimeType: file.type
        };
        
        // Salvar no servidor
        try {
          await fetch('/api/documents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newItem)
          });
          fetchSharedDocs(); // Atualizar lista global
          setContextItems(prev => [...prev, newItem]); // Ativação automática
        } catch (error) {
          console.error("Erro ao salvar no servidor:", error);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const addUrl = () => {
    if (!urlInput.trim() || !urlInput.startsWith('http')) return;
    const newItem: ContextItem = {
      id: Math.random().toString(36).substr(2, 9),
      type: 'url',
      name: urlInput.trim()
    };
    setContextItems(prev => [...prev, newItem]);
    setUrlInput('');
  };

  const toggleDocInContext = (doc: ContextItem) => {
    setContextItems(prev => {
      const exists = prev.find(item => item.id === doc.id);
      if (exists) return prev.filter(item => item.id !== doc.id);
      return [...prev, doc];
    });
  };

  const deleteDoc = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Tem certeza que deseja remover este documento da biblioteca compartilhada?")) return;
    try {
      await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      fetchSharedDocs();
      setContextItems(prev => prev.filter(item => item.id !== id));
    } catch (error) {
      console.error("Erro ao deletar:", error);
    }
  };

  return (
    <div className="flex h-screen bg-black text-white font-sans overflow-hidden">
      {/* User Name Prompt Overlay */}
      {!userName && (
        <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 p-8 rounded-2xl max-w-md w-full space-y-6 shadow-2xl">
            <div className="text-center space-y-2">
              <div className="w-16 h-16 bg-gold/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Shield className="text-gold" size={32} />
              </div>
              <h2 className="text-xl font-bold text-white">Identificação Necessária</h2>
              <p className="text-sm text-neutral-400">Por favor, insira seu nome para acessar o sistema da PCRS.</p>
            </div>
            <div className="space-y-4">
              <input 
                type="text" 
                placeholder="Seu nome completo"
                className="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-gold transition-colors"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.target as HTMLInputElement).value.trim()) {
                    const name = (e.target as HTMLInputElement).value.trim();
                    setUserName(name);
                    localStorage.setItem('pcrs_user_name', name);
                  }
                }}
              />
              <button 
                onClick={() => {
                  const inputEl = document.querySelector('input[placeholder="Seu nome completo"]') as HTMLInputElement;
                  if (inputEl.value.trim()) {
                    setUserName(inputEl.value.trim());
                    localStorage.setItem('pcrs_user_name', inputEl.value.trim());
                  }
                }}
                className="w-full bg-gold text-black font-bold py-3 rounded-xl hover:bg-yellow-500 transition-colors"
              >
                Entrar no Sistema
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin Login Overlay */}
      {showAdminLogin && (
        <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 p-8 rounded-2xl max-w-md w-full space-y-6 shadow-2xl">
            <div className="text-center space-y-2">
              <h2 className="text-xl font-bold text-white">Acesso Administrativo</h2>
              <p className="text-sm text-neutral-400">Insira a chave de acesso para visualizar os logs.</p>
            </div>
            <div className="space-y-4">
              <input 
                type="password" 
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="Chave de Acesso"
                className="w-full bg-black border border-neutral-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-gold transition-colors"
              />
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowAdminLogin(false)}
                  className="flex-1 bg-neutral-800 text-white font-bold py-3 rounded-xl hover:bg-neutral-700 transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  onClick={() => {
                    if (adminPassword === 'pcrs2024') { // Senha simples para o protótipo
                      setIsAdmin(true);
                      setShowAdminLogin(false);
                    } else {
                      alert('Chave incorreta');
                    }
                  }}
                  className="flex-1 bg-gold text-black font-bold py-3 rounded-xl hover:bg-yellow-500 transition-colors"
                >
                  Acessar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar - Context Management */}
      {/* Backdrop for mobile */}
      {showContextPanel && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] lg:hidden" 
          onClick={() => setShowContextPanel(false)}
        />
      )}

      <aside className={cn(
        "fixed inset-y-0 left-0 z-[70] w-80 bg-neutral-900 border-r border-neutral-800 transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0",
        showContextPanel ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex flex-col h-full">
          <div className="p-6 border-b border-neutral-800 relative">
            {/* Close button for mobile */}
            <button 
              onClick={() => setShowContextPanel(false)}
              className="lg:hidden absolute right-4 top-4 p-2 text-neutral-400 hover:text-white"
            >
              <X size={20} />
            </button>
            <div className="flex flex-col items-center gap-4 mb-8 cursor-pointer" onClick={() => setShowAdminLogin(true)}>
              <div className="relative h-40 w-40 flex items-center justify-center bg-transparent overflow-hidden">
                {/* Primary Image: PCRS Shield with scale to zoom in and mix-blend-screen to remove black background */}
                <img 
                  src="https://www.pc.rs.gov.br/upload/recortes/202405/16085838_498256_GDO.png" 
                  alt="Logo Polícia Civil RS" 
                  className="h-full w-full object-contain z-10 mix-blend-screen brightness-110 scale-[1.7]"
                  referrerPolicy="no-referrer"
                  onLoad={(e) => {
                    const fallback = e.currentTarget.parentElement?.querySelector('.fallback-icon');
                    if (fallback) fallback.classList.add('hidden');
                  }}
                  onError={(e) => {
                    const target = e.currentTarget;
                    if (target.getAttribute('data-tried-fallback')) {
                      target.style.display = 'none';
                      const fallback = target.parentElement?.querySelector('.fallback-icon');
                      if (fallback) fallback.classList.remove('hidden');
                      return;
                    }
                    target.setAttribute('data-tried-fallback', 'true');
                    target.src = "https://www.ssp.rs.gov.br/upload/recortes/201909/05155503_104161_GDO.jpg";
                  }}
                />
                {/* Fallback Badge */}
                <div className="fallback-icon absolute inset-0 flex items-center justify-center text-gold bg-neutral-900/40 rounded-lg border border-gold/10">
                  <Shield size={80} fill="currentColor" fillOpacity={0.1} strokeWidth={2.5} />
                </div>
              </div>
              <div className="text-center">
                <h1 className="text-3xl font-black tracking-tighter text-gold leading-none">PCRS</h1>
                <p className="text-xs font-bold text-white/40 uppercase tracking-[0.3em] mt-2">Consultor Normativo</p>
              </div>
            </div>
            <p className="text-sm text-neutral-400">Biblioteca Compartilhada</p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {isAdmin && (
              <div className="p-3 bg-gold/10 border border-gold/20 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-gold uppercase">Modo Administrador</span>
                  <button onClick={() => setIsAdmin(false)} className="text-[10px] text-neutral-400 hover:text-white underline">Sair</button>
                </div>
                <p className="text-[10px] text-neutral-400">Você está visualizando todos os logs do sistema.</p>
              </div>
            )}
            
            {/* Outline Structure Menu */}
            <nav className="space-y-4">
              {/* Section: Actions */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-[10px] font-bold text-neutral-500 uppercase tracking-widest px-2">
                  <ChevronDown size={10} /> Ações Rápidas
                </div>
                <div className="pl-4 border-l border-neutral-800 space-y-1">
                  <button 
                    onClick={() => {
                      fileInputRef.current?.click();
                      if (window.innerWidth < 1024) setShowContextPanel(false);
                    }}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-neutral-400 hover:bg-neutral-800 hover:text-gold transition-all group"
                  >
                    <Upload size={16} className="group-hover:scale-110 transition-transform" />
                    <span>Upload de PDFs</span>
                  </button>
                  <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".pdf" multiple className="hidden" />
                </div>
              </div>

              {/* Section: Library (Outline Style) */}
              <div className="space-y-2">
                <div 
                  className="flex items-center justify-between px-2 cursor-pointer hover:bg-neutral-800/30 rounded py-1 transition-colors"
                  onClick={() => setIsLibraryExpanded(!isLibraryExpanded)}
                >
                  <div className="flex items-center gap-2 text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
                    {isLibraryExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />} 
                    Biblioteca Global
                  </div>
                  <span className="text-[10px] bg-gold/10 text-gold px-1.5 py-0.5 rounded border border-gold/20">{sharedDocs.length}</span>
                </div>
                
                {isLibraryExpanded && (
                  <div className="pl-4 border-l border-neutral-800 space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
                    {sharedDocs.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-neutral-600 italic">Nenhum documento</div>
                    ) : (
                      sharedDocs.map(doc => (
                        <div 
                          key={doc.id} 
                          className="group flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-neutral-800/50 text-neutral-400 hover:text-neutral-200 transition-colors relative"
                        >
                          {/* Tree line connector */}
                          <div className="absolute -left-4 top-1/2 w-4 h-px bg-neutral-800"></div>
                          
                          <div className="flex items-center gap-2 overflow-hidden">
                            <FileText size={14} className="text-neutral-500 group-hover:text-gold" />
                            <span className="text-xs truncate">{doc.name}</span>
                          </div>
                          <button 
                            onClick={(e) => deleteDoc(doc.id, e)}
                            className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-1 transition-opacity"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Section: Personal History */}
              <div className="space-y-2">
                <div 
                  className="flex items-center justify-between px-2 cursor-pointer hover:bg-neutral-800/30 rounded py-1 transition-colors"
                  onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                >
                  <div className="flex items-center gap-2 text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
                    {isHistoryExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />} 
                    Meu Histórico
                  </div>
                  <span className="text-[10px] bg-gold/10 text-gold px-1.5 py-0.5 rounded border border-gold/20">{userHistory.length}</span>
                </div>
                
                {isHistoryExpanded && (
                  <div className="pl-4 border-l border-neutral-800 space-y-1 animate-in fade-in slide-in-from-top-1 duration-200">
                    {userHistory.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-neutral-600 italic">Nenhuma pergunta ainda</div>
                    ) : (
                      userHistory.map(item => (
                        <div 
                          key={item.id} 
                          onClick={() => {
                            setInput(item.content);
                            if (window.innerWidth < 1024) setShowContextPanel(false);
                          }}
                          className="group flex items-center gap-2 px-3 py-2 rounded-md hover:bg-neutral-800/50 text-neutral-400 hover:text-neutral-200 transition-colors relative cursor-pointer"
                        >
                          <div className="absolute -left-4 top-1/2 w-4 h-px bg-neutral-800"></div>
                          <History size={12} className="text-neutral-500 group-hover:text-gold shrink-0" />
                          <span className="text-[10px] truncate line-clamp-1">{item.content}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Section: Links (Outline Style) */}
              <div className="space-y-2">
                <div 
                  className="flex items-center gap-2 text-[10px] font-bold text-neutral-500 uppercase tracking-widest px-2 cursor-pointer hover:bg-neutral-800/30 rounded py-1 transition-colors"
                  onClick={() => setIsLinksExpanded(!isLinksExpanded)}
                >
                  {isLinksExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />} 
                  Links Ativos
                </div>
                {isLinksExpanded && (
                  <div className="pl-4 border-l border-neutral-800 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="flex gap-2 px-2">
                      <input 
                        type="text" 
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="https://..."
                        className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-xs focus:outline-none focus:border-gold/50 text-neutral-300"
                        onKeyDown={(e) => e.key === 'Enter' && addUrl()}
                      />
                      <button onClick={addUrl} className="p-1.5 bg-neutral-800 text-gold rounded hover:bg-neutral-700 transition-colors">
                        <Plus size={14} />
                      </button>
                    </div>
                    
                    <div className="space-y-1">
                      {contextItems.filter(i => i.type === 'url').map(item => (
                        <div 
                          key={item.id} 
                          className="group flex items-center justify-between px-3 py-1.5 rounded-md hover:bg-neutral-800/50 text-neutral-400 relative"
                        >
                          <div className="absolute -left-4 top-1/2 w-4 h-px bg-neutral-800"></div>
                          <div className="flex items-center gap-2 overflow-hidden">
                            <LinkIcon size={14} className="text-neutral-500 group-hover:text-gold" />
                            <span className="text-xs truncate">{item.name}</span>
                          </div>
                          <button 
                            onClick={() => setContextItems(prev => prev.filter(i => i.id !== item.id))}
                            className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-1 transition-opacity"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </nav>
          </div>

          <div className="p-6 border-t border-neutral-100 bg-neutral-50/50">
            <div className="flex items-center gap-2 text-[10px] text-neutral-400 uppercase font-bold tracking-widest">
              <Scale size={12} /> Baseado em IA
            </div>
          </div>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 grid grid-rows-[auto_auto_1fr_auto] h-screen bg-black overflow-hidden relative">
        {/* Header */}
        <header className="h-16 border-b border-neutral-800 bg-black/80 backdrop-blur-md flex items-center justify-between px-4 sm:px-6 z-40">
          <div className="flex items-center gap-3 sm:gap-4">
            <button 
              onClick={() => setShowContextPanel(!showContextPanel)}
              className="lg:hidden p-2 text-gold hover:bg-neutral-800 rounded-lg"
            >
              <Menu size={20} />
            </button>
            
            {/* Mobile Logo & Title */}
            <div className="flex items-center gap-3 lg:hidden">
              <div className="relative h-20 w-20 flex items-center justify-center p-0.5 overflow-hidden">
                <img 
                  src="https://www.pc.rs.gov.br/upload/recortes/202405/16085838_498256_GDO.png" 
                  alt="Logo PC" 
                  className="h-full w-full object-contain z-10 mix-blend-screen brightness-110 scale-[1.7]"
                  referrerPolicy="no-referrer"
                  onLoad={(e) => {
                    const fallback = e.currentTarget.parentElement?.querySelector('.header-fallback-icon');
                    if (fallback) fallback.classList.add('hidden');
                  }}
                  onError={(e) => {
                    const target = e.currentTarget;
                    if (target.getAttribute('data-tried-fallback')) {
                      target.style.display = 'none';
                      const fallback = target.parentElement?.querySelector('.header-fallback-icon');
                      if (fallback) fallback.classList.remove('hidden');
                      return;
                    }
                    target.setAttribute('data-tried-fallback', 'true');
                    target.src = "https://www.ssp.rs.gov.br/upload/recortes/201909/05155503_104161_GDO.jpg";
                  }}
                />
                <div className="header-fallback-icon absolute inset-0 flex items-center justify-center text-gold">
                  <Shield size={40} fill="currentColor" fillOpacity={0.1} strokeWidth={2.5} />
                </div>
              </div>
              <div className="flex flex-col">
                <span className="text-base font-black text-gold leading-tight tracking-tighter">POLÍCIA CIVIL</span>
                <span className="text-sm font-bold text-white/60 leading-none">ESTADO DO RS</span>
              </div>
            </div>

            <div className="hidden lg:block">
              <h2 className="text-sm font-bold text-gold">Conversa com Assistente</h2>
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-gold animate-pulse"></span>
                <span className="text-[10px] text-neutral-500 uppercase font-bold tracking-wider">
                  {isIndexing ? (
                    <span className="flex items-center gap-2 text-amber-500 animate-pulse">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Indexando Biblioteca para RAG...
                    </span>
                  ) : (
                    sharedDocs.length > 0 
                      ? `Consultando toda a Biblioteca (${sharedDocs.length} arquivos)` 
                      : "Pesquisa Geral Ativada"
                  )}
                </span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Status indicator for mobile (compact) */}
            <div className="lg:hidden flex items-center gap-1.5 bg-neutral-900/50 px-2 py-1 rounded-full border border-neutral-800">
              <span className="flex h-1.5 w-1.5 rounded-full bg-gold animate-pulse"></span>
              <span className="text-[8px] text-gold/80 font-bold uppercase tracking-tighter">
                {sharedDocs.length > 0 ? "Biblioteca" : "Geral"}
              </span>
            </div>
            <span className="text-xs text-gold/60 hidden sm:block">Polícia Civil RS</span>
          </div>
        </header>

        {/* Context Indicator Bar */}
        {sharedDocs.length > 0 ? (
          <div className="bg-neutral-900 border-b border-neutral-800 px-6 py-2 flex items-center gap-2 overflow-x-auto no-scrollbar">
            <span className="text-[10px] font-bold text-gold uppercase whitespace-nowrap">Biblioteca Ativa:</span>
            {sharedDocs.map(doc => (
              <span key={doc.id} className="text-[10px] bg-neutral-800 border border-neutral-700 text-neutral-300 px-2 py-0.5 rounded-md whitespace-nowrap flex items-center gap-1">
                <FileText size={10} className="text-gold" />
                {doc.name}
              </span>
            ))}
          </div>
        ) : <div />}

        {/* Messages */}
        <div 
          ref={scrollRef}
          className="overflow-y-auto p-6 space-y-8 custom-scrollbar min-h-0"
        >
          <div className="max-w-3xl mx-auto space-y-8 pb-10">
            {isAdmin ? (
              <div className="space-y-8">
                <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
                  <h3 className="text-lg font-bold text-gold flex items-center gap-2">
                    <History size={20} /> Histórico Global de Interações
                  </h3>
                  <span className="text-xs text-neutral-500">{allLogs.length} mensagens registradas</span>
                </div>
                
                <div className="space-y-4">
                  {allLogs.length === 0 ? (
                    <div className="text-center py-20 text-neutral-500 italic">Nenhum log registrado ainda.</div>
                  ) : (
                    allLogs.map((log, idx) => (
                      <div key={log.id || idx} className="bg-neutral-900/50 border border-neutral-800 p-4 rounded-xl space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-gold uppercase">{log.userName}</span>
                          <span className="text-[10px] text-neutral-500">{new Date(log.createdAt).toLocaleString()}</span>
                        </div>
                        <div className={cn(
                          "text-sm p-3 rounded-lg",
                          log.role === 'user' ? "bg-neutral-800 text-white" : "bg-gold/5 text-neutral-300 border border-gold/10"
                        )}>
                          <span className="text-[10px] font-bold uppercase opacity-50 block mb-1">{log.role === 'user' ? 'Pergunta' : 'Resposta IA'}</span>
                          <div className="markdown-body">
                            <Markdown>{log.content}</Markdown>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg) => (
                  <div 
                    key={msg.id} 
                    className={cn(
                      "flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300",
                      msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 shadow-md",
                      msg.role === 'user' ? "bg-gold text-black" : "bg-neutral-800 text-gold border border-neutral-700"
                    )}>
                      {msg.role === 'user' ? <MessageSquare size={16} /> : <Shield size={16} />}
                    </div>
                    <div className={cn(
                      "flex flex-col gap-2 max-w-[85%]",
                      msg.role === 'user' ? "items-end" : "items-start"
                    )}>
                      <div className={cn(
                        "p-4 rounded-2xl text-sm leading-relaxed border",
                        msg.role === 'user' 
                          ? "bg-neutral-900 border-neutral-800 text-white rounded-tr-none" 
                          : "bg-neutral-900 border-neutral-800 text-neutral-200 rounded-tl-none"
                      )}>
                        <div className="markdown-body">
                          <Markdown>{msg.content}</Markdown>
                        </div>
                      </div>
                      
                      <span className="text-[10px] text-neutral-500 mt-1 uppercase font-bold tracking-tighter">
                        {msg.role === 'user' ? userName : 'Assistente PCRS'}
                      </span>

                      {msg.sources && msg.sources.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {msg.sources.map((source, idx) => (
                            <a 
                              key={idx}
                              href={source.uri}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gold hover:text-gold/80 bg-gold/10 px-2 py-1 rounded-md transition-colors border border-gold/20"
                            >
                              <ExternalLink size={10} />
                              {source.title.length > 20 ? source.title.substring(0, 20) + '...' : source.title}
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}
            {isLoading && (
              <div className="flex gap-4 animate-pulse">
                <div className="w-8 h-8 bg-neutral-800 rounded-lg" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 bg-neutral-800 rounded w-3/4" />
                  <div className="h-4 bg-neutral-800 rounded w-1/2" />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Input Area - FORCED VISIBILITY */}
        <div className="p-6 md:p-10 bg-neutral-900 border-t-4 border-gold shadow-[0_-10px_40px_rgba(0,0,0,0.5)] z-50">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-1 w-8 bg-gold rounded-full animate-pulse"></div>
              <label htmlFor="chat-input" className="text-gold text-sm font-black uppercase tracking-[0.2em]">
                Faça sua pergunta aqui:
              </label>
            </div>
            <form 
              onSubmit={handleSendMessage}
              className="relative"
            >
              <input 
                id="chat-input"
                type="text" 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Escreva sua dúvida e aperte Enter..."
                className="w-full p-6 pr-20 bg-black border-2 border-gold/50 focus:border-gold rounded-2xl outline-none text-white text-lg transition-all shadow-[0_0_30px_rgba(212,175,55,0.1)] focus:shadow-[0_0_40px_rgba(212,175,55,0.2)] placeholder:text-neutral-700"
                disabled={isLoading}
                autoFocus
              />
              <button 
                type="submit"
                disabled={!input.trim() || isLoading}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-4 bg-gold text-black rounded-xl hover:bg-gold/90 disabled:opacity-30 transition-all shadow-lg active:scale-95"
              >
                {isLoading ? <Loader2 size={32} className="animate-spin" /> : <Send size={32} />}
              </button>
            </form>
            <div className="flex justify-between items-center mt-4">
              <p className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest">
                PCRS - Inteligência Artificial
              </p>
              <p className="text-[10px] text-gold font-bold flex items-center gap-1">
                <span className="h-1 w-1 bg-gold rounded-full animate-ping"></span>
                SISTEMA PRONTO
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
