import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";

const app = express();
const PORT = 3000;

// Aumentar limite para suportar PDFs grandes
app.use(express.json({ limit: '50mb' }));

// Configuração do Banco de Dados
const db = new Database("normas.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT,
    content TEXT,
    mimeType TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    userName TEXT,
    role TEXT,
    content TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// API Routes
app.get("/api/messages/user/:userName", (req, res) => {
  try {
    const messages = db.prepare("SELECT * FROM messages WHERE userName = ? ORDER BY createdAt DESC").all(req.params.userName);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar histórico do usuário" });
  }
});

app.get("/api/messages", (req, res) => {
  try {
    const messages = db.prepare("SELECT * FROM messages ORDER BY createdAt ASC").all();
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar mensagens" });
  }
});

app.post("/api/messages", (req, res) => {
  const { id, userName, role, content } = req.body;
  try {
    db.prepare("INSERT INTO messages (id, userName, role, content) VALUES (?, ?, ?, ?)")
      .run(id, userName, role, content);
    res.status(201).json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao salvar mensagem" });
  }
});

app.get("/api/documents", (req, res) => {
  try {
    const docs = db.prepare("SELECT id, name, type, mimeType FROM documents ORDER BY createdAt DESC").all();
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar documentos" });
  }
});

app.get("/api/documents/:id", (req, res) => {
  try {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
    if (!doc) return res.status(404).json({ error: "Documento não encontrado" });
    res.json(doc);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar documento" });
  }
});

app.post("/api/documents", (req, res) => {
  const { id, name, type, content, mimeType } = req.body;
  try {
    db.prepare("INSERT INTO documents (id, name, type, content, mimeType) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, type, content, mimeType);
    res.status(201).json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao salvar documento" });
  }
});

app.delete("/api/documents/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Erro ao deletar documento" });
  }
});

// Vite middleware para desenvolvimento
async function setupVite() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

setupVite();
